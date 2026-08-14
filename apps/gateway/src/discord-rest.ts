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
/** 11 = public thread, 12 = private thread, 10 = announcement thread.
 *  Threads are NOT returned by GET /guilds/:id/channels, so without fetching
 *  them separately a thread the agent is active in has no name, no parent and
 *  no way to open it — it shows as a bare snowflake, if at all. */
export const THREAD_TYPES = [10, 11, 12];

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

/** A rich embed. Whole channels can be nothing but these (a webhook/bot feed),
 *  so dropping them renders those channels as blank rows. */
export interface DiscordEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
  /** Discord's integer colour; the client renders it as the left accent bar. */
  color: number | null;
  timestamp: string | null;
  footer: string | null;
  authorName: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  fields: { name: string; value: string; inline: boolean }[];
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  content: string;
  /** Discord message type. 0/19 are normal; the rest are SYSTEM events (joins,
   *  pins, boosts...) that carry NO content — Discord synthesizes their text
   *  client-side, so a renderer that only prints `content` shows a blank row. */
  type: number;
  timestamp: string;
  editedTimestamp: string | null;
  author: DiscordAuthor;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  /** Users mentioned in `content`, so the client can turn `<@id>` into a real
   *  name without a second round-trip — Discord ships them with the message. */
  mentions: { id: string; displayName: string }[];
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
  const base = (chans ?? [])
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

  // Threads come from a different endpoint. An agent asked to watch a channel
  // routinely ends up talking in a thread under it, so leaving these out meant
  // the conversation the operator actually wanted was unreachable.
  // Best-effort: a guild where this 403s (missing intent/permission) should
  // still render its normal channels rather than failing the whole sidebar.
  let threads: DiscordChannel[] = [];
  try {
    const active = (await rest(token).get(`/guilds/${guildId}/threads/active`)) as {
      threads?: {
        id: string;
        type: number;
        name: string;
        parent_id: string | null;
        thread_metadata?: { archived?: boolean };
      }[];
    };
    threads = (active?.threads ?? [])
      .filter((t) => THREAD_TYPES.includes(t.type))
      .map((t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        // A thread's parent is a text CHANNEL, not a category — the client
        // nests it under that channel rather than in the category list.
        parentId: t.parent_id ?? null,
        position: 0,
        topic: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    /* no thread access in this guild — channels alone are still useful */
  }
  return [...base, ...threads];
}

interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  type?: number;
  timestamp: string;
  edited_timestamp: string | null;
  author: RawUser;
  /** Only present on search results — flags which entry in a context group is
   *  the actual match. */
  hit?: boolean;
  attachments?: {
    id: string;
    filename: string;
    url: string;
    content_type?: string;
    width?: number;
    height?: number;
    size: number;
  }[];
  embeds?: {
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    timestamp?: string;
    footer?: { text?: string };
    author?: { name?: string };
    image?: { url?: string };
    thumbnail?: { url?: string };
    fields?: { name: string; value: string; inline?: boolean }[];
  }[];
  mentions?: RawUser[];
  reactions?: { emoji: { name: string | null; id: string | null }; count: number; me: boolean }[];
  referenced_message?: { id: string; content: string; author: RawUser } | null;
}

/** Shared by history, search and send — one place that decides what the browser
 *  sees, so the three can never drift. */
function normalizeMessage(m: RawMessage, selfId?: string): DiscordMessage {
  return {
    id: m.id,
    channelId: m.channel_id,
    content: m.content ?? '',
    type: typeof m.type === 'number' ? m.type : 0,
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
    embeds: (m.embeds ?? []).map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
      color: typeof e.color === 'number' ? e.color : null,
      timestamp: e.timestamp ?? null,
      footer: e.footer?.text ?? null,
      authorName: e.author?.name ?? null,
      imageUrl: e.image?.url ?? null,
      thumbnailUrl: e.thumbnail?.url ?? null,
      fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })),
    })),
    mentions: (m.mentions ?? []).map((u) => ({ id: u.id, displayName: toAuthor(u).displayName })),
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
  };
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
  const raw = (await rest(token).get(`${Routes.channelMessages(channelId)}?${qs}`)) as RawMessage[];
  return (raw ?? []).map((m) => normalizeMessage(m, selfId));
}

/**
 * Guild-wide message search. This rides Discord's bot *search preview*, which
 * isn't part of the documented bot API and 403s for apps that don't have it —
 * verified working for this deployment, but callers must handle the failure.
 * Results come back as groups (the hit plus surrounding context); we take the
 * flagged hit, falling back to the first entry.
 */
export async function searchMessages(
  token: string,
  guildId: string,
  query: string,
  opts: { limit?: number; channelId?: string } = {},
): Promise<DiscordMessage[]> {
  const qs = new URLSearchParams({
    content: query,
    limit: String(Math.min(25, Math.max(1, opts.limit ?? 25))),
  });
  if (opts.channelId) qs.set('channel_id', opts.channelId);
  const res = (await rest(token).get(`/guilds/${guildId}/messages/search?${qs}`)) as {
    messages?: RawMessage[][];
  };
  const hits = (res?.messages ?? []).map((group) => group.find((m) => m.hit) ?? group[0]);
  return hits.filter(Boolean).map((m) => normalizeMessage(m as RawMessage));
}

export async function sendMessage(
  token: string,
  channelId: string,
  content: string,
  replyToId?: string,
): Promise<DiscordMessage> {
  const body: Record<string, unknown> = { content };
  if (replyToId) body.message_reference = { message_id: replyToId };
  // The POST response IS the created message, so normalize it directly rather
  // than re-reading the channel (which raced the write and could miss it).
  const created = (await rest(token).post(Routes.channelMessages(channelId), {
    body,
  })) as RawMessage;
  return normalizeMessage(created, created.author?.id);
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
