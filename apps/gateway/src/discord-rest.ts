// Operator-side Discord REST, used by the dashboard's Discord client.
//
// Why not go through the agent's `discord` MCP? That server is stdio-only —
// it's spawned by the agent's `claude` and has no HTTP surface, so the gateway
// cannot call it. Every tool it exposes is a stateless Discord REST call
// authenticated by a bot token the gateway already has on disk, so we make the
// same calls directly. That also means the client keeps working while the agent
// is stopped, which routing through the agent could never do.
//
// Everything here is normalized for the browser: avatar URLs are built, field
// names are camelCased, and only what the UI renders is passed through. The bot
// token NEVER leaves the gateway.
import { REST, Routes } from 'discord.js';

const rest = (token: string) => new REST({ version: '10' }).setToken(token);

/** Discord channel types we care about. 4 = category, 0/5 = text/announcement. */
export const CHANNEL_CATEGORY = 4;
export const TEXT_CHANNEL_TYPES = [0, 5];

export interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  /** Parent category id, so the sidebar can group like Discord does. */
  parentId: string | null;
  position: number;
  topic: string | null;
}

export interface DiscordAuthor {
  id: string;
  username: string;
  /** Display name when set, else the username. */
  displayName: string;
  avatarUrl: string;
  bot: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  contentType: string | null;
  width: number | null;
  height: number | null;
  size: number;
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  author: DiscordAuthor;
  attachments: DiscordAttachment[];
  reactions: { emoji: string; count: number; me: boolean }[];
  /** Present when this message is a reply, so the UI can show the quoted bar. */
  replyTo: { id: string; author: string; content: string } | null;
  /** True when the message came from the agent's own bot. */
  self: boolean;
}

/** Discord's default avatar for users with none set. Post-2023 usernames shard
 *  by (id >> 22) % 6; legacy discriminator accounts use discriminator % 5. */
function defaultAvatar(id: string, discriminator?: string): string {
  let index = 0;
  try {
    index = Number((BigInt(id) >> 22n) % 6n);
  } catch {
    index = discriminator ? Number(discriminator) % 5 : 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

interface RawUser {
  id: string;
  username?: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

function toAuthor(u: RawUser | undefined): DiscordAuthor {
  const id = u?.id ?? '0';
  const username = u?.username ?? 'unknown';
  return {
    id,
    username,
    displayName: u?.global_name || username,
    avatarUrl: u?.avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png?size=64`
      : defaultAvatar(id, u?.discriminator),
    bot: !!u?.bot,
  };
}

export async function listGuilds(token: string): Promise<DiscordGuild[]> {
  const guilds = (await rest(token).get(Routes.userGuilds())) as {
    id: string;
    name: string;
    icon: string | null;
  }[];
  return (guilds ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
  }));
}

export async function listChannels(token: string, guildId: string): Promise<DiscordChannel[]> {
  const chans = (await rest(token).get(Routes.guildChannels(guildId))) as {
    id: string;
    type: number;
    name: string;
    parent_id: string | null;
    position: number;
    topic?: string | null;
  }[];
  return (chans ?? [])
    .filter((c) => c.type === CHANNEL_CATEGORY || TEXT_CHANNEL_TYPES.includes(c.type))
    .map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      parentId: c.parent_id ?? null,
      position: c.position ?? 0,
      topic: c.topic ?? null,
    }))
    .sort((a, b) => a.position - b.position);
}

/** Newest-first, as Discord returns it. `before` pages backwards in time. */
export async function listMessages(
  token: string,
  channelId: string,
  opts: { limit?: number; before?: string } = {},
  selfId?: string,
): Promise<DiscordMessage[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const qs = new URLSearchParams({ limit: String(limit) });
  if (opts.before) qs.set('before', opts.before);
  const raw = (await rest(token).get(`${Routes.channelMessages(channelId)}?${qs}`)) as {
    id: string;
    channel_id: string;
    content: string;
    timestamp: string;
    edited_timestamp: string | null;
    author: RawUser;
    attachments?: {
      id: string;
      filename: string;
      url: string;
      content_type?: string;
      width?: number;
      height?: number;
      size: number;
    }[];
    reactions?: { emoji: { name: string | null; id: string | null }; count: number; me: boolean }[];
    referenced_message?: { id: string; content: string; author: RawUser } | null;
  }[];
  return (raw ?? []).map((m) => ({
    id: m.id,
    channelId: m.channel_id,
    content: m.content ?? '',
    timestamp: m.timestamp,
    editedTimestamp: m.edited_timestamp ?? null,
    author: toAuthor(m.author),
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      contentType: a.content_type ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
      size: a.size,
    })),
    reactions: (m.reactions ?? []).map((r) => ({
      emoji: r.emoji?.name ?? '?',
      count: r.count,
      me: r.me,
    })),
    replyTo: m.referenced_message
      ? {
          id: m.referenced_message.id,
          author: toAuthor(m.referenced_message.author).displayName,
          content: m.referenced_message.content ?? '',
        }
      : null,
    self: !!selfId && m.author?.id === selfId,
  }));
}

export async function sendMessage(
  token: string,
  channelId: string,
  content: string,
  replyToId?: string,
): Promise<DiscordMessage> {
  const body: Record<string, unknown> = { content };
  if (replyToId) body.message_reference = { message_id: replyToId };
  const created = (await rest(token).post(Routes.channelMessages(channelId), { body })) as {
    id: string;
  };
  const [msg] = await listMessages(token, channelId, { limit: 1 });
  return (
    msg ??
    ({ id: created.id, channelId, content, timestamp: new Date().toISOString() } as DiscordMessage)
  );
}

export async function addReaction(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await rest(token).put(
    Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)),
  );
}

/** Open (or reuse) the DM channel with a user — the only way to address a DM,
 *  since bots cannot enumerate their DM conversations. */
export async function openDm(token: string, userId: string): Promise<string> {
  const ch = (await rest(token).post(Routes.userChannels(), {
    body: { recipient_id: userId },
  })) as { id: string };
  return ch.id;
}

export async function getUser(token: string, userId: string): Promise<DiscordAuthor> {
  return toAuthor((await rest(token).get(Routes.user(userId))) as RawUser);
}

export async function whoami(token: string): Promise<DiscordAuthor> {
  return toAuthor((await rest(token).get(Routes.user('@me'))) as RawUser);
}
