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

export class DiscordBridge {
  private clients = new Map<string, Client>();

  isConnected(agentId: string): boolean {
    return this.clients.has(agentId);
  }

  /** (Re)connect the bot for one agent and deliver accepted messages. */
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

    // Per-channel "active conversation" timestamps: once the bot is talking in a
    // channel, follow-ups don't need to re-@mention it (people don't). A channel
    // goes cold after WINDOW_MS of silence, after which a mention is needed again.
    const lastActive = new Map<string, number>();
    const WINDOW_MS = 5 * 60_000;
    client.on(Events.MessageCreate, (msg) => {
      try {
        const selfId = client.user?.id;
        // The bot's own messages keep the conversation window open (but aren't
        // forwarded back to it).
        if (selfId && msg.author.id === selfId) {
          lastActive.set(msg.channelId, Date.now());
          return;
        }
        const mentioned = !!selfId && msg.mentions.users.has(selfId);
        const repliedToBot = !!selfId && msg.mentions.repliedUser?.id === selfId;
        const inConversation = Date.now() - (lastActive.get(msg.channelId) ?? 0) < WINDOW_MS;
        const addressed = mentioned || repliedToBot || inConversation;
        const text = formatInbound(msg, rules, selfId, addressed);
        if (!text) return;
        lastActive.set(msg.channelId, Date.now()); // keep the window alive
        const attachments = [...msg.attachments.values()].map((a) => ({
          url: a.url,
          name: a.name ?? 'file',
        }));
        void Promise.resolve(deliver({ text, attachments })).catch(() => {});
      } catch {
        /* never let a malformed event take the bridge down */
      }
    });
    client.on(Events.Error, () => {
      /* discord.js auto-reconnects; swallow to avoid crashing the gateway */
    });

    await client.login(token);
    this.clients.set(agentId, client);
  }

  async disconnect(agentId: string): Promise<void> {
    const client = this.clients.get(agentId);
    if (!client) return;
    this.clients.delete(agentId);
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.disconnect(id)));
  }
}

/** Apply the agent's rules to an incoming message; return the line to inject, or null. */
function formatInbound(
  // discord.js Message; typed loosely to avoid leaking the heavy generic here.
  msg: {
    author: { id: string; bot: boolean; username: string };
    guildId: string | null;
    channelId: string;
    id: string;
    content: string;
  },
  rules: DiscordRules,
  selfId: string | undefined,
  addressed: boolean,
): string | null {
  if (msg.author.id === selfId) return null; // never echo our own messages
  if (rules.ignoreBots && msg.author.bot) return null;

  const isDm = !msg.guildId;
  if (isDm) {
    if (!rules.forwardDms) return null;
  } else {
    if (rules.forwardChannelIds.length && !rules.forwardChannelIds.includes(msg.channelId))
      return null;
    // In channels, only forward when the bot is actually addressed — @mentioned,
    // replied to, or mid-conversation (default on, incl. legacy configs missing
    // the field) — so the agent isn't pulled into every message. DMs are
    // inherently directed.
    if (rules.requireMention !== false && !addressed) return null;
  }
  if (rules.allowedUserIds.length && !rules.allowedUserIds.includes(msg.author.id)) return null;

  const address = isDm
    ? `discord://dm/${msg.author.id}`
    : `discord://${msg.guildId}/${msg.channelId}#${msg.id}`;
  // Both the author name AND the body are attacker-controlled, so both must be
  // sanitized — otherwise a username like "[sys://wake]" forges a trusted prefix.
  const user = sanitizeInbound(msg.author.username);
  const body = sanitizeInbound(msg.content);
  return `**[${address}]** ${user}: ${body}`;
}
