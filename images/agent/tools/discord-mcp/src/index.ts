// Discord MCP server — the OUTGOING side of an agent's Discord integration.
// Pure REST (no Gateway): the receive side lives in the gateway's DiscordBridge.
// The bot token is read live from the agent's own .swarm/integrations.json, so
// this server is always registered but inert until the dashboard configures it.
//
// Addresses use the swarm routing scheme (see docs/discord-mcp-plan.md):
//   discord://dm/<userId>
//   discord://<guildId>/<channelId>[#<messageId>]
// Raw channel IDs are also accepted.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const INTEGRATIONS_FILE =
  process.env.SWARM_INTEGRATIONS_FILE ??
  `${process.env.HOME ?? '/home/agent'}/.swarm/integrations.json`;

/** Read the live bot token (null when the integration isn't configured). */
function readToken(): string | null {
  try {
    const store = JSON.parse(readFileSync(INTEGRATIONS_FILE, 'utf8')) as {
      discord?: { credentials?: { botToken?: string } };
    };
    const t = store?.discord?.credentials?.botToken;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** A fresh REST client bound to the current token, or a friendly error if unset. */
function getRest(): REST {
  const token = readToken();
  if (!token) {
    throw new Error(
      'Discord integration is not configured (no bot token). Set it in the dashboard → Integrations → Discord.',
    );
  }
  return new REST({ version: '10' }).setToken(token);
}

interface Parsed {
  channelId?: string;
  userId?: string;
  messageId?: string;
}

/** Parse a swarm Discord address (or a raw channel id) into its parts. */
function parseAddress(address: string): Parsed {
  const rest = address.startsWith('discord://') ? address.slice('discord://'.length) : address;
  if (rest.startsWith('dm/')) return { userId: rest.slice(3) };
  const [path, messageId] = rest.split('#');
  const parts = (path ?? '').split('/').filter(Boolean);
  const channelId = parts.length >= 2 ? parts[1] : parts[0];
  return { channelId, messageId };
}

/** Read the target from whatever the model called the arg: address (canonical),
 *  or the common guesses channel / channelId. */
function addrOf(args: Record<string, unknown>): string {
  return String(args.address ?? args.channel ?? args.channelId ?? args.channel_id ?? '');
}

/** Resolve an address to a concrete channel id (opening a DM channel if needed). */
async function resolveChannel(
  rest: REST,
  address: string,
): Promise<{ channelId: string; messageId?: string }> {
  const a = parseAddress(address);
  if (a.userId) {
    const dm = (await rest.post(Routes.userChannels(), {
      body: { recipient_id: a.userId },
    })) as { id: string };
    return { channelId: dm.id };
  }
  if (!a.channelId) throw new Error(`cannot resolve a channel from address: ${address}`);
  return { channelId: a.channelId, messageId: a.messageId };
}

const execFileAsync = promisify(execFile);

/** Capture the current X desktop to a temp JPEG (imagemagick `import`). */
async function captureScreen(): Promise<string> {
  const file = join(tmpdir(), `discord-shot-${process.pid}-${Date.now()}.jpg`);
  await execFileAsync('import', ['-window', 'root', '-quality', '80', file], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':1' },
  });
  return file;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({
  content: [
    { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
  ],
});

const TOOLS = [
  {
    name: 'discord_whoami',
    description: "The bot's own identity and the guilds (servers) it is in.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'discord_list_guilds',
    description: 'List the servers (guilds) the bot is a member of.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'discord_list_channels',
    description: 'List channels in a guild.',
    inputSchema: {
      type: 'object',
      properties: { guild: { type: 'string', description: 'Guild (server) id' } },
      required: ['guild'],
    },
  },
  {
    name: 'discord_read_messages',
    description: 'Read recent messages from a channel (newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'discord:// address or raw channel id' },
        limit: { type: 'number', description: '1–100 (default 25)' },
        before: { type: 'string', description: 'Message id to paginate before' },
      },
      required: ['address'],
    },
  },
  {
    name: 'discord_search',
    description: 'Search messages in a guild (Discord bot search preview).',
    inputSchema: {
      type: 'object',
      properties: {
        guild: { type: 'string', description: 'Guild (server) id' },
        query: { type: 'string', description: 'Search text' },
        limit: { type: 'number', description: '1–25 (default 25)' },
      },
      required: ['guild', 'query'],
    },
  },
  {
    name: 'discord_send_message',
    description: 'Send a message to a channel or DM. Optionally reply to a referenced message.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'discord:// address or raw channel id' },
        content: { type: 'string', description: 'Message text' },
        reply: {
          type: 'boolean',
          description: 'Reply to the message id embedded in the address (if any)',
        },
      },
      required: ['address', 'content'],
    },
  },
  {
    name: 'discord_add_reaction',
    description: 'React to a message with an emoji. The address must include a #messageId.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'discord://<guild>/<channel>#<messageId>' },
        emoji: { type: 'string', description: 'Unicode emoji (e.g. 👍) or custom "name:id"' },
      },
      required: ['address', 'emoji'],
    },
  },
  {
    name: 'discord_create_thread',
    description: 'Start a thread, optionally from the message id in the address.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'discord:// address or raw channel id' },
        name: { type: 'string', description: 'Thread name' },
      },
      required: ['address', 'name'],
    },
  },
  {
    name: 'discord_upload_file',
    description: 'Send a local file/image to a channel, with an optional caption.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'discord:// address or raw channel id' },
        path: { type: 'string', description: 'Absolute path to a local file' },
        caption: { type: 'string', description: 'Optional message text' },
      },
      required: ['address', 'path'],
    },
  },
  {
    name: 'discord_send_screenshot',
    description: "Capture the agent's current desktop and send it to a channel/DM.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'discord:// address or raw channel id' },
        caption: { type: 'string', description: 'Optional message text' },
      },
      required: ['address'],
    },
  },
  {
    name: 'discord_download_attachment',
    description:
      'Download a Discord attachment (or any URL) to a local file, then read that path to view it. Get attachment URLs from discord_read_messages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Attachment URL' },
        filename: { type: 'string', description: 'Optional filename to save as' },
      },
      required: ['url'],
    },
  },
];

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const rest = getRest();
  switch (name) {
    case 'discord_whoami': {
      const me = await rest.get(Routes.user('@me'));
      const guilds = await rest.get(Routes.userGuilds());
      return ok({ me, guilds });
    }
    case 'discord_list_guilds':
      return ok(await rest.get(Routes.userGuilds()));
    case 'discord_list_channels':
      return ok(await rest.get(Routes.guildChannels(String(args.guild))));
    case 'discord_read_messages': {
      const { channelId } = await resolveChannel(rest, addrOf(args));
      const query = new URLSearchParams({ limit: String(Math.min(100, Number(args.limit) || 25)) });
      if (args.before) query.set('before', String(args.before));
      return ok(await rest.get(Routes.channelMessages(channelId), { query }));
    }
    case 'discord_search': {
      const query = new URLSearchParams({
        content: String(args.query),
        limit: String(Math.min(25, Number(args.limit) || 25)),
      });
      // Bot search is a preview endpoint; not in discord-api-types Routes yet.
      return ok(await rest.get(`/guilds/${String(args.guild)}/messages/search`, { query }));
    }
    case 'discord_send_message': {
      const { channelId, messageId } = await resolveChannel(rest, addrOf(args));
      const body: Record<string, unknown> = { content: String(args.content) };
      if (args.reply && messageId) body.message_reference = { message_id: messageId };
      return ok(await rest.post(Routes.channelMessages(channelId), { body }));
    }
    case 'discord_add_reaction': {
      const { channelId, messageId } = await resolveChannel(rest, addrOf(args));
      if (!messageId) throw new Error('address must include a #messageId to react to');
      const emoji = encodeURIComponent(String(args.emoji));
      await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, emoji));
      return ok('reacted');
    }
    case 'discord_create_thread': {
      const { channelId, messageId } = await resolveChannel(rest, addrOf(args));
      const route = messageId ? Routes.threads(channelId, messageId) : Routes.threads(channelId);
      const body: Record<string, unknown> = { name: String(args.name) };
      // A channel-level thread (no anchor message) requires a thread `type`;
      // 11 = GUILD_PUBLIC_THREAD. (Message-anchored threads infer it.)
      if (!messageId) body.type = 11;
      return ok(await rest.post(route, { body }));
    }
    case 'discord_upload_file': {
      const { channelId } = await resolveChannel(rest, addrOf(args));
      const path = String(args.path);
      const data = await readFile(path);
      const body: Record<string, unknown> = {};
      if (args.caption) body.content = String(args.caption);
      return ok(
        await rest.post(Routes.channelMessages(channelId), {
          body,
          files: [{ name: basename(path), data }],
        }),
      );
    }
    case 'discord_send_screenshot': {
      const { channelId } = await resolveChannel(rest, addrOf(args));
      const file = await captureScreen();
      const data = await readFile(file);
      const body: Record<string, unknown> = {};
      if (args.caption) body.content = String(args.caption);
      return ok(
        await rest.post(Routes.channelMessages(channelId), {
          body,
          files: [{ name: 'screenshot.jpg', data }],
        }),
      );
    }
    case 'discord_download_attachment': {
      const url = String(args.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const base = (
        args.filename ? String(args.filename) : (url.split('/').pop()?.split('?')[0] ?? 'file')
      ).replace(/[^\w.\-]/g, '_');
      const dir = join(tmpdir(), 'discord-dl');
      await mkdir(dir, { recursive: true });
      const p = join(dir, `${Date.now()}-${base}`);
      await writeFile(p, buf);
      return ok({ path: p, bytes: buf.byteLength });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

const server = new Server({ name: 'discord', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await dispatch(name, (args ?? {}) as Record<string, unknown>);
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
