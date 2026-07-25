// The Discord "bridge": the receive side of the Discord integration. It holds a
// long-lived Gateway (WebSocket) connection per agent and, when a message
// arrives that the agent's rules accept, types it into the agent's `claude`
// terminal — exactly like the dashboard "send" does. Outgoing actions are NOT
// here; those go through the in-agent Discord MCP server (REST). See
// docs/discord-mcp-plan.md §4–5.
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
  REST,
  Routes,
} from 'discord.js';
import type { DiscordRules, IntegrationTestResult } from './types.js';

/** One accepted inbound Discord message, ready to deliver to the agent. */
export interface InboundMessage {
  /** Formatted, sanitized line (routing prefix + author + body). */
  text: string;
  /** Attachment URLs to download so the agent can view/read them. */
  attachments: { url: string; name: string }[];
  /** Interrupt the agent's current turn (Esc) and handle this now, rather than
   *  letting it queue behind the in-flight turn. Set for direct address
   *  (@mention / reply / DM). */
  interrupt?: boolean;
}

/** Delivers an accepted message to the agent (download attachments + inject). */
export type Deliver = (msg: InboundMessage) => void | Promise<void>;

/**
 * Neutralise any forged routing prefix in untrusted message text so a Discord
 * user can't impersonate a `[scheme://…]` tag (especially the privileged
 * `[sys://…]`). We collapse newlines (the injected message is one line) and
 * backslash-escape the `[` that introduces a `scheme://` token.
 */
export function sanitizeInbound(text: string): string {
  return (
    (text || '')
      .replace(/\s*\n+\s*/g, ' ⏎ ')
      .replace(/\t/g, ' ')
      // Control characters are written straight into the agent's pty, where ESC
      // is Claude Code's interrupt key and CSI starts a terminal escape
      // sequence. Newlines/tabs are already folded above, so drop the rest.
      // eslint-disable-next-line no-control-regex -- matching them is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\[(?=[A-Za-z][\w.]*:\/\/)/g, '\\[')
      .trim()
  );
}

/** Validate a bot token over REST (no Gateway): identity + guild list. */
export async function testDiscordToken(token: string): Promise<IntegrationTestResult> {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    const me = (await rest.get(Routes.user('@me'))) as {
      username: string;
      discriminator?: string;
      id: string;
    };
    const guilds = (await rest.get(Routes.userGuilds())) as { id: string; name: string }[];
    const tag =
      me.discriminator && me.discriminator !== '0'
        ? `${me.username}#${me.discriminator}`
        : me.username;
    return {
      ok: true,
      at: Date.now(),
      botTag: tag,
      guilds: (guilds ?? []).map((g) => ({ id: g.id, name: g.name })),
    };
  } catch (e) {
    return { ok: false, at: Date.now(), detail: e instanceof Error ? e.message : String(e) };
  }
}

/** How long after the last interaction the agent stays "online" (attentive). */
const ONLINE_MS = 10 * 60_000;
/** How often we check for the idle→wake transition. */
const WAKE_CHECK_MS = 60_000;
/** Grace period after delivering a Discord message before we nudge the agent
 *  about not having answered. Long enough for a real turn, short enough that a
 *  human on the other end isn't left staring at nothing. */
const REPLY_NUDGE_MS = 2 * 60_000;
/** How much of the replied-to message to quote back. The full text is one
 *  discord_read_messages away via the `#<id>` in the clause. */
const REPLY_QUOTE_MAX = 180;

interface Conn {
  client: Client;
  timer: ReturnType<typeof setInterval>;
  setCustom: (text: string) => void;
  /** Read back the agent's own status quote (for the dashboard's client). */
  getCustom: () => string | null;
  /** Presence the bridge last applied ('online' while attentive, else 'idle'). */
  getPresence: () => 'online' | 'idle' | null;
  /** Cancel any armed reply-nudge (on disconnect). */
  cancelNudge: () => void;
}

export class DiscordBridge {
  private conns = new Map<string, Conn>();

  isConnected(agentId: string): boolean {
    return this.conns.has(agentId);
  }

  /** Set (or clear, with an empty string) this agent's bot custom status — the
   *  little "status quote" under its name. Returns false when the bot isn't
   *  connected (Discord not configured, or offline). */
  /** The bot's live presence + status quote, for the operator's Discord client.
   *  Null when the bridge isn't connected for this agent. */
  presenceOf(agentId: string): {
    connected: boolean;
    presence: 'online' | 'idle' | null;
    customStatus: string | null;
  } {
    const conn = this.conns.get(agentId);
    if (!conn) return { connected: false, presence: null, customStatus: null };
    return { connected: true, presence: conn.getPresence(), customStatus: conn.getCustom() };
  }

  setCustomStatus(agentId: string, text: string): boolean {
    const conn = this.conns.get(agentId);
    if (!conn) return false;
    conn.setCustom(text);
    return true;
  }

  /**
   * (Re)connect the bot for one agent. Implements an online/idle attention model:
   *  - ONLINE (interaction within ONLINE_MS): every watched-channel message is
   *    forwarded in real time; the bot's Discord presence shows online.
   *  - IDLE: plain channel messages are buffered as "unread" (not forwarded);
   *    presence shows idle. A @mention/reply/DM wakes it immediately; otherwise a
   *    `[sys://wake]` nudge fires (only while unread > 0) telling it to catch up.
   */
  async connect(
    agentId: string,
    token: string,
    rules: DiscordRules,
    deliver: Deliver,
  ): Promise<void> {
    await this.disconnect(agentId);
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        // Reaction intents exist only so an emoji reaction counts as "the agent
        // responded" and cancels the reply nudge below.
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      // Channel: required to receive DMs. Message/Reaction: required to get
      // reaction events on messages that aren't in the cache.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    let onlineUntil = 0; // attentive until this timestamp; 0 = idle
    let presence: 'online' | 'idle' | null = null;
    let customStatus: string | null = null; // the agent's own "status quote"
    const unread = new Map<string, number>(); // channelId -> messages buffered while idle

    // Apply the current status + custom activity to the bot's Discord presence.
    const applyPresence = () => {
      try {
        client.user?.setPresence({
          status: presence ?? 'idle',
          activities: customStatus
            ? [{ name: 'Custom Status', type: ActivityType.Custom, state: customStatus }]
            : [],
        });
      } catch {
        /* presence is best-effort */
      }
    };
    /** Apply unconditionally. Needed wherever Discord may have discarded our
     *  presence — a session that can't RESUME re-IDENTIFYs, and Discord then
     *  defaults the bot to online — because the equality guard in setPresence
     *  would otherwise leave Discord and the dashboard disagreeing. */
    const forcePresence = (s: 'online' | 'idle') => {
      presence = s;
      applyPresence();
    };
    const setPresence = (s: 'online' | 'idle') => {
      if (presence === s) return;
      forcePresence(s);
    };
    /** What our presence SHOULD be right now, from the attention model. */
    const intendedPresence = (): 'online' | 'idle' =>
      Date.now() < onlineUntil ? 'online' : 'idle';
    // Agent-set custom status. Empty clears it; re-applied on every presence
    // change. Lives for this connection (reset if the bot reconnects).
    const setCustom = (text: string) => {
      const t = (text || '').trim();
      customStatus = t.length ? t.slice(0, 128) : null; // Discord caps custom status at 128
      applyPresence();
    };
    const bumpOnline = () => {
      onlineUntil = Date.now() + ONLINE_MS;
      setPresence('online');
    };
    const send = (
      text: string,
      attachments: { url: string; name: string }[] = [],
      interrupt = false,
    ) => void Promise.resolve(deliver({ text, attachments, interrupt })).catch(() => {});

    // ── Reply nudge ─────────────────────────────────────────────────────────
    // The gateway can't see the in-agent Discord MCP's REST calls, but it DOES
    // see the resulting message come back over the Gateway socket as one of the
    // bot's own — and, with the reaction intents above, its reactions too. So
    // "did the agent respond?" is observable here without touching the agent.
    //
    // One timer at a time per agent: the first unanswered message arms it, and
    // anything the agent sends disarms it. A second inbound message while the
    // timer is already running does NOT restart the clock — the point is to
    // notice silence, not to count messages.
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeFor = ''; // who/where we're waiting on, for the nudge text
    const cancelNudge = () => {
      if (!nudgeTimer) return;
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    };
    const armNudge = (who: string, address: string) => {
      if (nudgeTimer) return; // already waiting on an earlier message
      nudgeFor = `${who} (${address})`;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        send(
          `**[sys://reply]** You received a Discord message from ${nudgeFor} about 2 minutes ago ` +
            `and the gateway has not seen you send anything back — no message, reply, or reaction ` +
            `from your bot. They are probably still waiting. If you're mid-task, post a short ` +
            `acknowledgement so they know you're on it; if you have the answer, send it; if it ` +
            `genuinely needs no reply, ignore this.`,
        );
      }, REPLY_NUDGE_MS);
      // Don't hold the event loop open on shutdown.
      nudgeTimer.unref?.();
    };

    // `on`, not `once`: discord.js reconnects on its own, and every fresh
    // IDENTIFY resets the bot's presence server-side. Re-asserting on each
    // ready/resume is what keeps Discord and the dashboard in agreement.
    client.on(Events.ClientReady, () => forcePresence(intendedPresence()));
    client.on(Events.ShardReady, () => forcePresence(intendedPresence()));
    client.on(Events.ShardResume, () => forcePresence(intendedPresence()));

    // The agent reacting to a message counts as a response.
    client.on(Events.MessageReactionAdd, (_reaction, user) => {
      if (client.user?.id && user.id === client.user.id) cancelNudge();
    });

    client.on(Events.MessageCreate, (msg) => {
      try {
        const selfId = client.user?.id;
        // The bot's own messages keep it online (but aren't forwarded back).
        // They're also the signal that the agent answered — disarm the nudge.
        if (selfId && msg.author.id === selfId) {
          cancelNudge();
          return bumpOnline();
        }
        if (rules.ignoreBots && msg.author.bot) return;

        const isDm = !msg.guildId;
        // Distinguish the three ways a message can arrive. `mentioned` keeps its
        // original meaning exactly (it still gates routing + interrupt); the new
        // flags only feed the label the agent sees.
        const repliedUser = msg.mentions.repliedUser;
        const repliedToMe = !!selfId && repliedUser?.id === selfId;
        const mentioned = !!selfId && (msg.mentions.users.has(selfId) || repliedToMe);
        // A literal @bot typed in the body. `mentions.users` also contains the
        // bot for a reply-with-ping, so it can't tell these apart on its own.
        const atMention = !!selfId && (msg.mentions.parsedUsers?.has(selfId) ?? false);
        const reply = replyContext(msg, repliedToMe);
        const attachments = [...msg.attachments.values()].map((a) => ({
          url: a.url,
          name: a.name ?? 'file',
        }));
        const opts = { atMention, reply };
        // Arm the reply watchdog for anything we actually hand to the agent.
        const forward = (
          line: string,
          address: string,
          atts: { url: string; name: string }[],
          interrupt: boolean,
        ) => {
          armNudge(sanitizeInbound(msg.author.username), address);
          send(line, atts, interrupt);
        };

        if (isDm) {
          if (!rules.forwardDms) return;
          // DM allow-list: if set, only these users may DM the agent.
          if (rules.allowedUserIds.length && !rules.allowedUserIds.includes(msg.author.id)) return;
          bumpOnline();
          unread.clear();
          // A DM is direct address → interrupt if the agent is mid-turn.
          return forward(formatLine(msg, true, opts), addressOf(msg, true), attachments, true);
        }

        if (rules.forwardChannelIds.length) {
          // Watched channels: online → forward all; idle → buffer unless @-addressed.
          if (!rules.forwardChannelIds.includes(msg.channelId)) {
            // Outside the watch-list: only let a single @mention/reply through when
            // "respond to mentions anywhere" is on (no history, no buffering).
            if (mentioned && rules.respondToMentionsAnywhere) {
              bumpOnline();
              return forward(
                formatLine(msg, false, opts),
                addressOf(msg, false),
                attachments,
                true,
              );
            }
            return;
          }
          if (mentioned || Date.now() < onlineUntil) {
            bumpOnline();
            unread.clear();
            // @mention/reply = handle now (interrupt); a plain message while
            // online just gets forwarded and queues if the agent is busy.
            return forward(
              formatLine(msg, false, opts),
              addressOf(msg, false),
              attachments,
              mentioned,
            );
          }
          unread.set(msg.channelId, (unread.get(msg.channelId) ?? 0) + 1);
          setPresence('idle');
          return;
        }

        // No watch list → whole server: only @mentions/replies (or gate-off) pass.
        if (mentioned || rules.requireMention === false) {
          bumpOnline();
          forward(formatLine(msg, false, opts), addressOf(msg, false), attachments, mentioned);
        }
      } catch {
        /* never let a malformed event take the bridge down */
      }
    });
    client.on(Events.Error, () => {
      /* discord.js auto-reconnects; swallow to avoid crashing the gateway */
    });

    // Idle sweep: once idle, if messages piled up unread, fire ONE wake nudge that
    // brings the agent back online to catch up. Only fires while unread > 0.
    const timer = setInterval(() => {
      try {
        // Re-assert every sweep so any drift self-heals within a minute rather
        // than persisting until the next reconnect.
        forcePresence(intendedPresence());
        if (Date.now() < onlineUntil) return; // still online
        const total = [...unread.values()].reduce((a, b) => a + b, 0);
        if (total === 0) return;
        const channels = [...unread.keys()];
        bumpOnline(); // waking up to handle the backlog
        unread.clear();
        send(
          `**[sys://wake]** ${total} new message(s) arrived while you were idle in channel(s): ` +
            `${channels.join(', ')}. Read them with discord_read_messages and reply to anything relevant.`,
        );
      } catch {
        /* ignore */
      }
    }, WAKE_CHECK_MS);

    await client.login(token);
    this.conns.set(agentId, {
      client,
      timer,
      setCustom,
      getCustom: () => customStatus,
      getPresence: () => presence,
      cancelNudge,
    });
  }

  async disconnect(agentId: string): Promise<void> {
    const conn = this.conns.get(agentId);
    if (!conn) return;
    this.conns.delete(agentId);
    clearInterval(conn.timer);
    conn.cancelNudge();
    try {
      await conn.client.destroy();
    } catch {
      /* ignore */
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }
}

/** The `discord://…` routing address the agent echoes back when replying. */
function addressOf(
  msg: { author: { id: string }; guildId: string | null; channelId: string; id: string },
  isDm: boolean,
): string {
  return isDm
    ? `discord://dm/${msg.author.id}`
    : `discord://${msg.guildId}/${msg.channelId}#${msg.id}`;
}

/** What the message being replied to was, when this message is a reply. */
export interface ReplyContext {
  /** Display name of the replied-to author, or 'you' when it's the agent. */
  author: string;
  messageId: string;
  /** Sanitized + truncated quote; '' when the original wasn't cached. */
  excerpt: string;
  toMe: boolean;
}

/**
 * Extract reply context from an inbound message, cache-only.
 *
 * discord.js injects `referenced_message` into the channel cache while building
 * the Message, so a normal reply is a free synchronous hit. We deliberately do
 * NOT fall back to `fetchReference()`: that await would let a later message
 * overtake an earlier one in this handler and deliver them out of order. A
 * cache miss (original deleted, or very old) just costs us the quote, not the
 * label. `MessageType.Reply` is the crisp test — it excludes forwards, which
 * also populate `reference`.
 */
function replyContext(
  msg: {
    type?: number;
    reference?: { messageId?: string | null } | null;
    mentions: { repliedUser?: { username?: string } | null };
    channel?: unknown;
  },
  toMe: boolean,
): ReplyContext | null {
  if (msg.type !== MessageType.Reply) return null;
  const messageId = msg.reference?.messageId;
  if (!messageId) return null;
  const cache = (
    msg.channel as { messages?: { cache?: Map<string, { content?: string }> } } | undefined
  )?.messages?.cache;
  const original = cache?.get(messageId);
  const quote = sanitizeInbound(original?.content ?? '');
  const author = toMe ? 'you' : sanitizeInbound(msg.mentions.repliedUser?.username ?? 'someone');
  return {
    author: author.slice(0, 64) || 'someone',
    messageId,
    excerpt: quote.length > REPLY_QUOTE_MAX ? `${quote.slice(0, REPLY_QUOTE_MAX)}…` : quote,
    toMe,
  };
}

/**
 * Format one message as a routing-prefixed line. Author + body are sanitized so
 * untrusted text can't forge a `[scheme://…]` prefix.
 *
 * Shape (single line — the routing protocol is one line per message):
 *   **[<address>]** <author><qualifier>: <body>  [in reply to <who> #<id> — "…"]
 *
 * The qualifier tells the agent HOW it was addressed, which it previously had
 * no way to know: an @mention, a reply to its own message, a reply to someone
 * else, or ambient channel chatter (no qualifier). It sits before the `:` in
 * the gateway-authored region and is built from a fixed set — a Discord user
 * can't forge one, since every interpolated name goes through sanitizeInbound.
 */
export function formatLine(
  msg: {
    author: { id: string; username: string };
    guildId: string | null;
    channelId: string;
    id: string;
    content: string;
  },
  isDm: boolean,
  opts: { atMention: boolean; reply: ReplyContext | null } = { atMention: false, reply: null },
): string {
  const address = addressOf(msg, isDm);
  const user = sanitizeInbound(msg.author.username);
  const body = sanitizeInbound(msg.content);
  const { atMention, reply } = opts;
  // Reply-to-you outranks @mention: it's the more specific fact.
  const qualifier = reply
    ? reply.toMe
      ? ' (reply to you)'
      : ` (reply to ${reply.author})`
    : atMention
      ? ' (@mention)'
      : '';
  // Trailing bracketed clause, same typography as the attachment clause that
  // deliverInbound appends after it.
  const clause = reply
    ? `  [in reply to ${reply.author} #${reply.messageId}${
        reply.excerpt
          ? ` — "${reply.excerpt}"`
          : ' — (original not available; use discord_read_messages)'
      }]`
    : '';
  return `**[${address}]** ${user}${qualifier}: ${body}${clause}`;
}
