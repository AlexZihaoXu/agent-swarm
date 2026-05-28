// The Discord "bridge": the receive side of the Discord integration. It holds a
// long-lived Gateway (WebSocket) connection per agent and, when a message
// arrives that the agent's rules accept, types it into the agent's `claude`
// terminal — exactly like the dashboard "send" does. Outgoing actions are NOT
// here; those go through the in-agent Discord MCP server (REST). See
// docs/discord-mcp-plan.md §4–5.
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
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
  return (text || '')
    .replace(/\s*\n+\s*/g, ' ⏎ ')
    .replace(/\[(?=[A-Za-z][\w.]*:\/\/)/g, '\\[')
    .trim();
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

interface Conn {
  client: Client;
  timer: ReturnType<typeof setInterval>;
}

export class DiscordBridge {
  private conns = new Map<string, Conn>();

  isConnected(agentId: string): boolean {
    return this.conns.has(agentId);
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
      ],
      partials: [Partials.Channel], // required to receive DMs
    });

    let onlineUntil = 0; // attentive until this timestamp; 0 = idle
    let presence: 'online' | 'idle' | null = null;
    const unread = new Map<string, number>(); // channelId -> messages buffered while idle

    const setPresence = (s: 'online' | 'idle') => {
      if (presence === s) return;
      presence = s;
      try {
        client.user?.setPresence({ status: s });
      } catch {
        /* presence is best-effort */
      }
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

    client.once(Events.ClientReady, () => setPresence('idle'));

    client.on(Events.MessageCreate, (msg) => {
      try {
        const selfId = client.user?.id;
        // The bot's own messages keep it online (but aren't forwarded back).
        if (selfId && msg.author.id === selfId) return bumpOnline();
        if (rules.ignoreBots && msg.author.bot) return;
        if (rules.allowedUserIds.length && !rules.allowedUserIds.includes(msg.author.id)) return;

        const isDm = !msg.guildId;
        const mentioned =
          !!selfId && (msg.mentions.users.has(selfId) || msg.mentions.repliedUser?.id === selfId);
        const attachments = [...msg.attachments.values()].map((a) => ({
          url: a.url,
          name: a.name ?? 'file',
        }));

        if (isDm) {
          if (!rules.forwardDms) return;
          bumpOnline();
          unread.clear();
          // A DM is direct address → interrupt if the agent is mid-turn.
          return send(formatLine(msg, true), attachments, true);
        }

        if (rules.forwardChannelIds.length) {
          // Watched channels: online → forward all; idle → buffer unless @-addressed.
          if (!rules.forwardChannelIds.includes(msg.channelId)) return;
          if (mentioned || Date.now() < onlineUntil) {
            bumpOnline();
            unread.clear();
            // @mention/reply = handle now (interrupt); a plain message while
            // online just gets forwarded and queues if the agent is busy.
            return send(formatLine(msg, false), attachments, mentioned);
          }
          unread.set(msg.channelId, (unread.get(msg.channelId) ?? 0) + 1);
          setPresence('idle');
          return;
        }

        // No watch list → whole server: only @mentions/replies (or gate-off) pass.
        if (mentioned || rules.requireMention === false) {
          bumpOnline();
          send(formatLine(msg, false), attachments, mentioned);
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
        if (Date.now() < onlineUntil) return; // still online
        setPresence('idle');
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
    this.conns.set(agentId, { client, timer });
  }

  async disconnect(agentId: string): Promise<void> {
    const conn = this.conns.get(agentId);
    if (!conn) return;
    this.conns.delete(agentId);
    clearInterval(conn.timer);
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

/** Format one message as a routing-prefixed line. Author + body are sanitized so
 *  untrusted text can't forge a `[scheme://…]` prefix. */
function formatLine(
  msg: {
    author: { id: string; username: string };
    guildId: string | null;
    channelId: string;
    id: string;
    content: string;
  },
  isDm: boolean,
): string {
  const address = isDm
    ? `discord://dm/${msg.author.id}`
    : `discord://${msg.guildId}/${msg.channelId}#${msg.id}`;
  const user = sanitizeInbound(msg.author.username);
  const body = sanitizeInbound(msg.content);
  return `**[${address}]** ${user}: ${body}`;
}
