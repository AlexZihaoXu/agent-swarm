// The Discord "bridge": the receive side of the Discord integration. It holds a
// long-lived Gateway (WebSocket) connection per agent and, when a message
// arrives that the agent's rules accept, types it into the agent's `claude`
// terminal — exactly like the dashboard "send" does. Outgoing actions are NOT
// here; those go through the in-agent Discord MCP server (REST). See
// docs/discord-mcp-plan.md §4–5.
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import type { DiscordRules, IntegrationTestResult } from './types.js';

/** Writes one already-formatted line into the agent's claude terminal. */
export type InjectFn = (text: string) => Promise<void>;

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

  /** (Re)connect the bot for one agent and forward accepted messages via `inject`. */
  async connect(
    agentId: string,
    token: string,
    rules: DiscordRules,
    inject: InjectFn,
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

    client.on(Events.MessageCreate, (msg) => {
      try {
        const line = formatInbound(msg, rules, client.user?.id);
        if (line) void inject(line).catch(() => {});
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
): string | null {
  if (msg.author.id === selfId) return null; // never echo our own messages
  if (rules.ignoreBots && msg.author.bot) return null;

  const isDm = !msg.guildId;
  if (isDm) {
    if (!rules.forwardDms) return null;
  } else if (rules.forwardChannelIds.length && !rules.forwardChannelIds.includes(msg.channelId)) {
    return null;
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
