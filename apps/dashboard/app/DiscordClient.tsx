'use client';

import { Button, Card, Dropdown, Input, Label, TextField } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  LuArrowDown,
  LuArrowRight,
  LuCopy,
  LuCornerUpLeft,
  LuDownload,
  LuFile,
  LuFileArchive,
  LuFileAudio,
  LuFileCode,
  LuFileImage,
  LuFileJson,
  LuFileSpreadsheet,
  LuFileText,
  LuFileVideo,
  LuHash,
  LuLoaderCircle,
  LuMessagesSquare,
  LuSearch,
  LuSend,
  LuSmile,
  LuUser,
  LuX,
} from 'react-icons/lu';
import {
  DISCORD_CATEGORY,
  discordChannels,
  discordGuilds,
  discordMessages,
  discordOpenDm,
  discordReact,
  discordSearch,
  discordSend,
  discordUser,
  discordWhoami,
  listIntegrations,
  type DiscordAttachment,
  type DiscordAuthor,
  type DiscordChannel,
  type DiscordEmbed,
  type DiscordGuild,
  type DiscordMessage,
  type DiscordSelf,
} from '@/lib/gateway';
import type { MilkdownApi } from '@/app/editors/MilkdownEditor';

// ProseMirror + the Crepe theme are heavy; keep them out of the main bundle.
const MilkdownEditor = dynamic(() => import('@/app/editors/MilkdownEditor'), { ssr: false });

/** How often an open channel re-polls. The bridge has no operator-facing push
 *  stream, so this is a plain interval — cheap, since Discord returns ≤50 rows. */
const POLL_MS = 5_000;
/** Consecutive messages from one author inside this window render as one block
 *  (avatar + name once), which is most of what makes it read like Discord. */
const GROUP_WINDOW_MS = 5 * 60_000;
/** Rows fetched per page when scrolling back through history. */
const PAGE_SIZE = 50;
/** Hard cap on retained messages. Paging back is unbounded, so without this the
 *  DOM grows until the tab crawls; we drop from the far end as we page. */
const MAX_RETAINED = 300;

type Target =
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'dm'; id: string; name: string; userId: string };

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today at ${time}` : `${d.toLocaleDateString()} ${time}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Discord renders newest at the bottom; the API returns newest-first. */
const chronological = (msgs: DiscordMessage[]) => [...msgs].reverse();

const isImage = (a: DiscordAttachment) => !!a.contentType?.startsWith('image/');

/**
 * Discord synthesizes system-event text CLIENT-side from the message type — the
 * payload carries no content at all. A renderer that only prints `content`
 * therefore shows a blank row, which is exactly what #general's two join
 * messages were doing.
 */
const SYSTEM_TEXT: Record<number, (who: string) => string> = {
  1: (w) => `${w} added someone to the group.`,
  2: (w) => `${w} removed someone from the group.`,
  4: (w) => `${w} changed the channel name.`,
  5: (w) => `${w} changed the channel icon.`,
  6: (w) => `${w} pinned a message to this channel.`,
  7: (w) => `${w} joined the server.`,
  8: (w) => `${w} boosted the server!`,
  9: (w) => `${w} boosted the server!`,
  10: (w) => `${w} boosted the server!`,
  11: (w) => `${w} boosted the server!`,
  12: (w) => `${w} added a channel follow here.`,
  18: (w) => `${w} started a thread.`,
  21: (w) => `${w} started a thread from a message.`,
  46: (w) => `A poll from ${w} closed.`,
};
/** 0 = normal, 19 = reply; everything else is a system event. */
const isSystem = (m: DiscordMessage) => m.type !== 0 && m.type !== 19;
/** True when we'd otherwise render an entirely empty row. */
const isEmpty = (m: DiscordMessage) =>
  !m.content.trim() && !m.embeds.length && !m.attachments.length;

/** One-line system event, styled like Discord's: indented, muted, no avatar. */
function SystemLine({ msg }: { msg: DiscordMessage }) {
  const who = msg.author.displayName;
  const text = SYSTEM_TEXT[msg.type]?.(who);
  return (
    <div className="text-muted flex items-baseline gap-2 px-4 py-1 text-sm">
      <LuArrowRight className="text-success size-3.5 shrink-0 translate-y-0.5" />
      <span className="min-w-0 flex-1">
        {text ?? (
          // Never render nothing: an unknown system type still says what it is,
          // so a blank row can't silently reappear.
          <span className="italic opacity-70">unsupported message type {msg.type}</span>
        )}
      </span>
      <span className="shrink-0 text-xs opacity-70">{timeLabel(msg.timestamp)}</span>
    </div>
  );
}

/** Pick a file glyph from the MIME type, falling back to the extension. */
function fileIcon(a: DiscordAttachment) {
  const type = a.contentType ?? '';
  const ext = a.filename.split('.').pop()?.toLowerCase() ?? '';
  if (type.startsWith('image/')) return LuFileImage;
  if (type.startsWith('video/')) return LuFileVideo;
  if (type.startsWith('audio/')) return LuFileAudio;
  if (type === 'application/json' || ext === 'json') return LuFileJson;
  if (type === 'application/pdf' || ext === 'pdf') return LuFileText;
  if (['zip', 'gz', 'tar', 'rar', '7z', 'xz', 'bz2'].includes(ext)) return LuFileArchive;
  if (['csv', 'xlsx', 'xls', 'ods'].includes(ext)) return LuFileSpreadsheet;
  if (
    ['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'sh', 'rb', 'php'].includes(
      ext,
    )
  )
    return LuFileCode;
  if (type.startsWith('text/') || ['txt', 'md', 'log'].includes(ext)) return LuFileText;
  return LuFile;
}

/** Non-image attachment: icon + filename + size, with the filename acting as
 *  the download link. */
function AttachmentCard({ attachment }: { attachment: DiscordAttachment }) {
  const Icon = fileIcon(attachment);
  const ext = attachment.filename.split('.').pop()?.toUpperCase() ?? 'FILE';
  return (
    <Card className="group mt-1 max-w-[420px] p-0">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Icon className="text-muted size-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            download={attachment.filename}
            className="text-link block truncate text-sm font-medium hover:underline"
            title={attachment.filename}
          >
            {attachment.filename}
          </a>
          <p className="text-muted truncate text-xs">
            {ext} · {fmtBytes(attachment.size)}
            {attachment.width && attachment.height
              ? ` · ${attachment.width}×${attachment.height}`
              : ''}
          </p>
        </div>
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          download={attachment.filename}
          aria-label={`Download ${attachment.filename}`}
          className="text-muted hover:text-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <LuDownload className="size-4" />
        </a>
      </div>
    </Card>
  );
}

/**
 * Rewrite Discord's non-markdown tokens into markdown react-markdown can carry.
 *
 * Mentions and channel refs become links with a private scheme (`mention:` /
 * `channel:`), because a link is the one inline construct react-markdown lets
 * us intercept with a component override — see `Body`. Left as literals they'd
 * render as noise, and `<@123>` would be swallowed as an HTML-ish tag.
 */
function preprocess(
  content: string,
  users: Map<string, string>,
  channels: Map<string, string>,
): string {
  return (
    content
      // <t:1712345678:R> → a readable local time
      .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_m, secs: string) =>
        new Date(Number(secs) * 1000).toLocaleString(),
      )
      // <:name:id> / <a:name:id> (custom + animated emoji) → :name:
      .replace(/<a?:(\w+):\d+>/g, ':$1:')
      .replace(
        /<#(\d+)>/g,
        (_m, id: string) => `[#${channels.get(id) ?? 'channel'}](channel:${id})`,
      )
      .replace(
        /<@[!&]?(\d+)>/g,
        (_m, id: string) => `[@${users.get(id) ?? 'unknown'}](mention:${id})`,
      )
      // Discord underlines __text__; GFM would read it as bold. Keep it as
      // emphasis so it doesn't collide with **bold**.
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '*$1*')
  );
}

/** One markdown body. Mention/channel links render as inline pills. */
function Body({
  content,
  users,
  channels,
}: {
  content: string;
  users: Map<string, string>;
  channels: Map<string, string>;
}) {
  const text = useMemo(() => preprocess(content, users, channels), [content, users, channels]);
  return (
    <div className="discord-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) =>
            href?.startsWith('mention:') || href?.startsWith('channel:') ? (
              <span className="discord-mention">{children}</span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A rich embed. Entire channels can be nothing but these, so this isn't a
 *  decorative extra — without it those channels render as blank rows. */
function Embed({
  embed,
  users,
  channels,
  onImage,
}: {
  embed: DiscordEmbed;
  users: Map<string, string>;
  channels: Map<string, string>;
  onImage: (url: string) => void;
}) {
  const accent =
    embed.color !== null ? `#${embed.color.toString(16).padStart(6, '0')}` : 'var(--separator)';
  return (
    <div
      className="bg-surface-secondary/60 mt-1.5 max-w-[520px] rounded border-l-4 px-4 py-3"
      style={{ borderLeftColor: accent }}
    >
      {embed.authorName && <p className="text-xs font-semibold">{embed.authorName}</p>}
      {embed.title &&
        (embed.url ? (
          <a
            href={embed.url}
            target="_blank"
            rel="noreferrer"
            className="text-link text-sm font-semibold hover:underline"
          >
            {embed.title}
          </a>
        ) : (
          <p className="text-sm font-semibold">{embed.title}</p>
        ))}
      {embed.description && <Body content={embed.description} users={users} channels={channels} />}
      {embed.fields.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1.5">
          {embed.fields.map((f, i) => (
            <div key={`${f.name}-${i}`} className={f.inline ? 'min-w-[30%] flex-1' : 'w-full'}>
              <p className="text-xs font-semibold">{f.name}</p>
              <Body content={f.value} users={users} channels={channels} />
            </div>
          ))}
        </div>
      )}
      {embed.thumbnailUrl && (
        <img
          src={embed.thumbnailUrl}
          alt=""
          onClick={() => onImage(embed.thumbnailUrl!)}
          className="mt-1.5 max-h-24 cursor-zoom-in rounded"
          loading="lazy"
        />
      )}
      {embed.imageUrl && (
        <img
          src={embed.imageUrl}
          alt=""
          onClick={() => onImage(embed.imageUrl!)}
          className="mt-1.5 max-h-72 max-w-full cursor-zoom-in rounded"
          loading="lazy"
        />
      )}
      {(embed.footer || embed.timestamp) && (
        <p className="text-muted mt-1.5 text-[11px]">
          {embed.footer}
          {embed.footer && embed.timestamp ? ' · ' : ''}
          {embed.timestamp ? new Date(embed.timestamp).toLocaleString() : ''}
        </p>
      )}
    </div>
  );
}

function MessageBlock({
  msg,
  grouped,
  users,
  channels,
  onContextMenu,
  onImage,
}: {
  msg: DiscordMessage;
  grouped: boolean;
  users: Map<string, string>;
  channels: Map<string, string>;
  onContextMenu: (e: MouseEvent, msg: DiscordMessage) => void;
  onImage: (url: string) => void;
}) {
  return (
    // Keyed by message id upstream, so a poll returning the same rows doesn't
    // re-animate — only genuinely new messages ease in.
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onContextMenu={(e) => onContextMenu(e, msg)}
      className={`hover:bg-surface-secondary/40 px-4 transition-colors duration-100 ${grouped ? 'py-1' : 'mt-6 py-1'}`}
    >
      {msg.replyTo && (
        <div className="text-muted mb-1 flex items-center gap-1.5 pl-12 text-xs">
          <span className="border-separator ml-[-1.5rem] h-3 w-6 rounded-tl border-t border-l" />
          <span className="font-medium">{msg.replyTo.author}</span>
          <span className="truncate opacity-80">{msg.replyTo.content || '(no text)'}</span>
        </div>
      )}
      <div className="flex gap-4">
        {grouped ? (
          <span className="w-10 shrink-0" />
        ) : (
          <img
            src={msg.author.avatarUrl}
            alt=""
            className="mt-0.5 size-10 shrink-0 rounded-full"
            loading="lazy"
          />
        )}
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="mb-0.5 flex items-baseline gap-2">
              <span className="text-foreground text-[0.95rem] font-medium">
                {msg.author.displayName}
              </span>
              {msg.author.bot && (
                <span className="bg-accent text-accent-foreground rounded px-1 py-px text-[10px] font-semibold">
                  BOT
                </span>
              )}
              <span className="text-muted text-xs">{timeLabel(msg.timestamp)}</span>
            </div>
          )}
          {msg.content && <Body content={msg.content} users={users} channels={channels} />}
          {msg.embeds.map((e, i) => (
            <Embed key={i} embed={e} users={users} channels={channels} onImage={onImage} />
          ))}
          {msg.attachments.map((a) =>
            isImage(a) ? (
              <img
                key={a.id}
                src={a.url}
                alt={a.filename}
                onClick={() => onImage(a.url)}
                className="border-separator mt-1 max-h-80 max-w-full cursor-zoom-in rounded border"
                loading="lazy"
              />
            ) : (
              <AttachmentCard key={a.id} attachment={a} />
            ),
          )}
          {msg.reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {msg.reactions.map((r) => (
                <span
                  key={r.emoji}
                  className={`border-separator rounded border px-1.5 py-0.5 text-xs ${
                    r.me ? 'bg-accent/20 border-accent' : 'bg-surface-secondary'
                  }`}
                >
                  {r.emoji} {r.count}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** Full-size image viewer. Backdrop click closes; clicking the image toggles
 *  between fit-to-screen and 1:1 zoom. */
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={onClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 ${
        zoomed ? 'overflow-auto' : ''
      }`}
    >
      <motion.img
        src={url}
        alt=""
        initial={{ scale: 0.96 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        // Stop propagation so clicking the image zooms instead of closing.
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((z) => !z);
        }}
        className={
          zoomed ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in rounded'
        }
      />
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 cursor-pointer rounded-full bg-black/50 p-2 text-white/80 transition-colors hover:text-white"
      >
        <LuX className="size-5" />
      </button>
    </motion.div>
  );
}

/** Placeholder rows while the first page loads — steadier than a lone spinner,
 *  and it reserves roughly the right space so nothing jumps on arrival. */
function Skeleton() {
  return (
    <div className="space-y-4 px-4 pt-4">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex animate-pulse gap-3" style={{ animationDelay: `${i * 90}ms` }}>
          <div className="bg-surface-secondary size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2 py-1">
            <div className="bg-surface-secondary h-3 w-32 rounded" />
            <div className="bg-surface-secondary h-3 rounded" style={{ width: `${60 + i * 8}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A Discord client scoped to one agent's bot: read history and post as that
 * agent. Laid out like Discord on purpose (guild rail → channel sidebar →
 * messages → composer) so it's navigable without relearning anything.
 *
 * One panel from real Discord is deliberately absent: the member list needs the
 * privileged Server Members intent the bridge doesn't request, so it would
 * always be empty. DMs also can't be enumerated (Discord returns nothing for
 * bots), so that list is seeded from the integration's allowedUserIds — which
 * is the set of humans allowed to DM this agent anyway.
 */
export function DiscordClient({ agentId }: { agentId: string }) {
  const [me, setMe] = useState<DiscordSelf | null>(null);
  const [guilds, setGuilds] = useState<DiscordGuild[]>([]);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [dmUsers, setDmUsers] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Map<string, DiscordAuthor>>(new Map());
  const [target, setTarget] = useState<Target | null>(null);
  const [messages, setMessages] = useState<DiscordMessage[]>([]);
  const [replyTo, setReplyTo] = useState<DiscordMessage | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; msg: DiscordMessage } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DiscordMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  /** Bumped after each send to remount (and thus clear) the Milkdown editor. */
  const [composerKey, setComposerKey] = useState(0);

  const editorRef = useRef<MilkdownApi | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Ref drives the autoscroll decision (read inside effects without
   *  re-rendering); the state drives the jump-to-bottom button. */
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /** Messages that arrived while the user was scrolled away. */
  const [missed, setMissed] = useState(0);

  // Identity + guilds + the DM allow-list (our only source of DM targets).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [who, gs, ints] = await Promise.all([
          discordWhoami(agentId),
          discordGuilds(agentId),
          listIntegrations(agentId).catch(() => []),
        ]);
        if (!alive) return;
        setMe(who);
        setGuilds(gs);
        setDmUsers(ints.find((i) => i.type === 'discord')?.rules?.allowedUserIds ?? []);
        if (gs.length) setGuildId(gs[0]!.id);
        else setLoading(false);
      } catch (e) {
        if (alive) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  // Resolve DM correspondents to real profiles, so the sidebar shows a person
  // rather than a snowflake.
  useEffect(() => {
    let alive = true;
    for (const uid of dmUsers) {
      if (profiles.has(uid)) continue;
      void discordUser(agentId, uid)
        .then((u) => alive && setProfiles((prev) => new Map(prev).set(uid, u)))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [agentId, dmUsers, profiles]);

  useEffect(() => {
    if (!guildId) return;
    let alive = true;
    void discordChannels(agentId, guildId)
      .then((cs) => {
        if (!alive) return;
        setChannels(cs);
        const first = cs.find((c) => c.type !== DISCORD_CATEGORY);
        if (first) setTarget({ kind: 'channel', id: first.id, name: first.name });
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String((e as Error)?.message ?? e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agentId, guildId]);

  const load = useCallback(async () => {
    if (!target) return;
    try {
      const msgs = await discordMessages(agentId, target.id, { limit: PAGE_SIZE, self: me?.id });
      setMessages((prev) => {
        const next = chronological(msgs);
        // Keep anything older we've already paged in, so a poll doesn't undo
        // the user's scrollback.
        const known = new Set(next.map((m) => m.id));
        const oldest = next[0]?.timestamp ?? '';
        const older = prev.filter((m) => !known.has(m.id) && m.timestamp < oldest);
        return [...older, ...next].slice(-MAX_RETAINED);
      });
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [agentId, target, me?.id]);

  useEffect(() => {
    if (!target) return;
    setMessages([]);
    setExhausted(false);
    setReplyTo(null);
    setMissed(0);
    setAtBottom(true);
    lastIdRef.current = null;
    atBottomRef.current = true;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [target, load]);

  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    const newest = messages[messages.length - 1];
    const isNew = !!newest && newest.id !== lastIdRef.current;
    lastIdRef.current = newest?.id ?? null;
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    } else if (isNew) {
      // Scrolled away and something landed — surface it on the button rather
      // than yanking the viewport out from under the reader.
      setMissed((n) => n + 1);
    }
  }, [messages]);

  /** Page backwards when the user reaches the top, holding their scroll anchor. */
  const loadOlder = useCallback(async () => {
    const el = scrollRef.current;
    const oldest = messages[0];
    if (!target || !oldest || paging || exhausted || !el || results) return;
    setPaging(true);
    const before = el.scrollHeight;
    try {
      const older = await discordMessages(agentId, target.id, {
        limit: PAGE_SIZE,
        before: oldest.id,
        self: me?.id,
      });
      if (!older.length) setExhausted(true);
      else {
        setMessages((prev) => [...chronological(older), ...prev].slice(0, MAX_RETAINED));
        // Restore the viewport to whatever the user was looking at.
        requestAnimationFrame(() => {
          const node = scrollRef.current;
          if (node) node.scrollTop += node.scrollHeight - before;
        });
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setPaging(false);
    }
  }, [agentId, target, messages, paging, exhausted, results, me?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setMissed(0);
    if (el.scrollTop < 120) void loadOlder();
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setAtBottom(true);
    setMissed(0);
  };

  const openDm = async (userId: string) => {
    try {
      const { channelId } = await discordOpenDm(agentId, userId);
      setResults(null);
      setTarget({
        kind: 'dm',
        id: channelId,
        name: profiles.get(userId)?.displayName ?? userId,
        userId,
      });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const send = async () => {
    const content = (editorRef.current?.getMarkdown() ?? '').trim();
    if (!content || !target || sending) return;
    setSending(true);
    try {
      await discordSend(agentId, target.id, content, replyTo?.id);
      setReplyTo(null);
      setComposerKey((k) => k + 1); // remount clears the editor
      atBottomRef.current = true;
      setAtBottom(true);
      setMissed(0);
      await load();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q || !guildId) return;
    setSearching(true);
    try {
      setResults(await discordSearch(agentId, guildId, q, { limit: 25 }));
      setError(null);
    } catch (e) {
      setError(`search failed: ${String((e as Error)?.message ?? e)}`);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const onMenuAction = (key: string) => {
    const msg = menu?.msg;
    setMenu(null);
    if (!msg) return;
    if (key === 'reply') setReplyTo(msg);
    else if (key === 'copy') void navigator.clipboard?.writeText(msg.content).catch(() => {});
    else if (key === 'copyId') void navigator.clipboard?.writeText(msg.id).catch(() => {});
    else if (key.startsWith('react:') && target) {
      void discordReact(agentId, target.id, msg.id, key.slice(6))
        .then(() => load())
        .catch((e) => setError(String((e as Error)?.message ?? e)));
    }
  };

  /** id → name lookups used to resolve <#id> and <@id> inside message text. */
  const channelNames = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);
  const userNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, p] of profiles) m.set(id, p.displayName);
    // Discord ships the mentioned users with each message, so names resolve
    // without a second round-trip.
    for (const msg of messages) for (const u of msg.mentions) m.set(u.id, u.displayName);
    if (me) m.set(me.id, me.displayName);
    return m;
  }, [messages, profiles, me]);

  // Text channels grouped under their category. Two channels can share a name
  // in different categories, so the grouping is what disambiguates them.
  const grouped = useMemo(() => {
    const cats = channels.filter((c) => c.type === DISCORD_CATEGORY);
    const text = channels.filter((c) => c.type !== DISCORD_CATEGORY);
    const out: { category: string | null; channels: DiscordChannel[] }[] = [];
    const loose = text.filter((c) => !c.parentId);
    if (loose.length) out.push({ category: null, channels: loose });
    for (const cat of cats) {
      const kids = text.filter((c) => c.parentId === cat.id);
      if (kids.length) out.push({ category: cat.name, channels: kids });
    }
    return out;
  }, [channels]);

  const shown = results ?? messages;

  return (
    <div className="bg-surface flex h-full min-h-0 overflow-hidden">
      {/* Guild rail */}
      <nav className="bg-surface-tertiary flex w-[68px] shrink-0 flex-col items-center gap-2 overflow-y-auto py-3">
        <button
          type="button"
          aria-label="Direct messages"
          onClick={() => setGuildId(null)}
          className={`flex size-12 cursor-pointer items-center justify-center rounded-[24px] transition-all duration-200 hover:rounded-2xl ${
            guildId === null ? 'bg-accent text-accent-foreground rounded-2xl' : 'bg-surface'
          }`}
        >
          <LuMessagesSquare className="size-6" />
        </button>
        <span className="bg-separator h-px w-8 shrink-0" />
        {guilds.map((g) => (
          <div key={g.id} className="group relative flex w-full justify-center">
            {/* Discord's left-edge pill: short on hover, tall when active. */}
            <span
              className={`bg-foreground absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r transition-all duration-200 ${
                guildId === g.id ? 'h-8' : 'h-2 opacity-0 group-hover:opacity-100'
              }`}
            />
            <button
              type="button"
              title={g.name}
              onClick={() => setGuildId(g.id)}
              className={`size-12 shrink-0 cursor-pointer overflow-hidden transition-all duration-200 hover:rounded-2xl ${
                guildId === g.id ? 'rounded-2xl' : 'rounded-[24px]'
              }`}
            >
              {g.iconUrl ? (
                <img src={g.iconUrl} alt={g.name} className="size-full object-cover" />
              ) : (
                <span className="bg-surface flex size-full items-center justify-center text-sm font-semibold">
                  {g.name.slice(0, 2)}
                </span>
              )}
            </button>
          </div>
        ))}
      </nav>

      {/* Channel / DM sidebar */}
      <aside className="bg-surface-secondary flex w-56 shrink-0 flex-col">
        <div className="border-separator flex h-12 items-center border-b px-4 font-semibold">
          <span className="truncate text-sm">
            {guildId ? (guilds.find((g) => g.id === guildId)?.name ?? 'Server') : 'Direct Messages'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {guildId === null ? (
            <>
              <p className="text-muted px-3 py-1 text-[11px] font-semibold tracking-wide uppercase">
                Direct Messages
              </p>
              {dmUsers.length === 0 && (
                <p className="text-muted px-3 py-2 text-xs leading-relaxed">
                  No DM contacts. Discord doesn&apos;t let bots list their DMs, so these come from
                  the integration&apos;s allowed-user list.
                </p>
              )}
              {dmUsers.map((u) => {
                const p = profiles.get(u);
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => void openDm(u)}
                    className={`hover:bg-surface-tertiary mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors duration-100 ${
                      target?.kind === 'dm' && target.userId === u
                        ? 'bg-surface-tertiary text-foreground'
                        : 'text-muted'
                    }`}
                  >
                    {p ? (
                      <img src={p.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />
                    ) : (
                      <LuUser className="size-4 shrink-0" />
                    )}
                    <span className="truncate">{p?.displayName ?? u}</span>
                  </button>
                );
              })}
            </>
          ) : (
            grouped.map((group) => (
              <div key={group.category ?? '_'} className="mb-3">
                {group.category && (
                  <p className="text-muted px-3 py-1 text-[11px] font-semibold tracking-wide uppercase">
                    {group.category}
                  </p>
                )}
                {group.channels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setResults(null);
                      setTarget({ kind: 'channel', id: c.id, name: c.name });
                    }}
                    className={`hover:bg-surface-tertiary mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm transition-colors duration-100 ${
                      target?.id === c.id
                        ? 'bg-surface-tertiary text-foreground'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    <LuHash className="size-4 shrink-0 opacity-70" />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        {/* Bot panel — mirrors Discord's user panel, showing the bot's LIVE
            presence and its own status quote rather than a static label. */}
        {me && (
          <div className="border-separator bg-surface-tertiary flex items-center gap-2 border-t px-2 py-2">
            <span className="relative shrink-0">
              <img src={me.avatarUrl} alt="" className="size-8 rounded-full" />
              <span
                title={
                  !me.connected ? 'Bridge offline' : me.presence === 'online' ? 'Online' : 'Idle'
                }
                className={`border-surface-tertiary absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 ${
                  !me.connected
                    ? 'bg-muted'
                    : me.presence === 'online'
                      ? 'bg-success'
                      : 'bg-warning'
                }`}
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{me.displayName}</p>
              <p className="text-muted truncate text-[11px]" title={me.customStatus ?? undefined}>
                {me.customStatus ||
                  (!me.connected ? 'bridge offline' : me.presence === 'online' ? 'online' : 'idle')}
              </p>
            </div>
          </div>
        )}
      </aside>

      {/* Conversation */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-separator flex h-12 shrink-0 items-center gap-2 border-b px-4">
          {target?.kind === 'dm' ? (
            <LuUser className="text-muted size-4" />
          ) : (
            <LuHash className="text-muted size-5" />
          )}
          <span className="truncate font-semibold">{target?.name ?? 'Select a channel'}</span>
          {guildId && (
            <div className="ml-auto flex items-center gap-1.5">
              <TextField
                className="w-52"
                aria-label="Search messages"
                value={query}
                onChange={setQuery}
              >
                <Input
                  className="h-8 text-sm"
                  placeholder="Search this server"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch();
                    if (e.key === 'Escape') {
                      setQuery('');
                      setResults(null);
                    }
                  }}
                />
              </TextField>
              <Button
                size="sm"
                variant="tertiary"
                aria-label="Search"
                isDisabled={!query.trim() || searching}
                onPress={() => void runSearch()}
              >
                {searching ? (
                  <LuLoaderCircle className="size-4 animate-spin" />
                ) : (
                  <LuSearch className="size-4" />
                )}
              </Button>
            </div>
          )}
        </header>

        {results && (
          <div className="border-separator text-muted flex items-center gap-2 border-b px-4 py-1.5 text-xs">
            <span>
              {results.length} result{results.length === 1 ? '' : 's'} for{' '}
              <span className="text-foreground font-medium">{query}</span>
            </span>
            <Button
              size="sm"
              variant="tertiary"
              className="ml-auto h-6 cursor-pointer gap-1 px-1.5 text-[11px]"
              onPress={() => setResults(null)}
            >
              <LuX className="size-3" /> Clear
            </Button>
          </div>
        )}

        {error && (
          <p className="text-danger border-separator border-b px-4 py-2 text-sm">{error}</p>
        )}

        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto pb-4">
            {loading && <Skeleton />}
            {paging && (
              <div className="text-muted flex items-center justify-center gap-2 py-2 text-xs">
                <LuLoaderCircle className="size-3 animate-spin" /> Loading older messages…
              </div>
            )}
            {exhausted && !results && messages.length > 0 && (
              <p className="text-muted px-4 py-3 text-xs">Beginning of the conversation.</p>
            )}
            {!loading && target && shown.length === 0 && (
              <div className="text-muted flex flex-col items-center gap-2 py-16 text-sm">
                <LuMessagesSquare className="size-8 opacity-40" />
                {results ? 'No matches.' : 'No messages here yet.'}
              </div>
            )}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                // Keyed by conversation (or the search view) so switching
                // cross-fades instead of swapping content under the scroll.
                key={results ? `search:${query}` : (target?.id ?? 'none')}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
              >
                {shown.map((m, i) => {
                  const prev = shown[i - 1];
                  const isGrouped =
                    !results &&
                    !!prev &&
                    prev.author.id === m.author.id &&
                    !m.replyTo &&
                    new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() <
                      GROUP_WINDOW_MS;
                  if (isSystem(m) && isEmpty(m)) return <SystemLine key={m.id} msg={m} />;
                  return (
                    <MessageBlock
                      key={m.id}
                      msg={m}
                      grouped={isGrouped}
                      users={userNames}
                      channels={channelNames}
                      onImage={setLightbox}
                      onContextMenu={(e, msg) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, msg });
                      }}
                    />
                  );
                })}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Jump to present — Discord's floating pill, shown only once the
              reader has scrolled away from the newest message. */}
          <AnimatePresence>
            {!atBottom && shown.length > 0 && (
              <motion.button
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                onClick={jumpToBottom}
                className="bg-surface-tertiary border-separator hover:bg-surface-secondary absolute right-6 bottom-3 flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg transition-colors"
              >
                <LuArrowDown className="size-3.5" />
                {missed > 0 ? `${missed} new message${missed === 1 ? '' : 's'}` : 'Jump to present'}
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Composer */}
        <div className="px-4 pb-4">
          {replyTo && (
            <div className="border-separator bg-surface-secondary text-muted flex items-center gap-2 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs">
              <LuCornerUpLeft className="size-3.5 shrink-0" />
              <span className="truncate">
                Replying to{' '}
                <span className="text-foreground font-medium">{replyTo.author.displayName}</span>
              </span>
              <button
                type="button"
                aria-label="Cancel reply"
                onClick={() => setReplyTo(null)}
                className="hover:text-foreground ml-auto cursor-pointer"
              >
                <LuX className="size-3.5" />
              </button>
            </div>
          )}
          <div
            className={`bg-surface-secondary focus-within:border-accent border-separator flex items-end gap-2 border px-2 py-1.5 transition-colors ${
              replyTo ? 'rounded-b-lg' : 'rounded-lg'
            }`}
            onKeyDown={(e) => {
              // Enter inserts a newline in the markdown editor, so sending is an
              // explicit gesture: the button, or Ctrl/Cmd+Enter.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
          >
            <div className="discord-composer max-h-40 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
              <MilkdownEditor key={composerKey} defaultValue="" apiRef={editorRef} />
            </div>
            <button
              type="button"
              aria-label="Send"
              disabled={!target || sending}
              onClick={() => void send()}
              className="text-muted hover:text-accent shrink-0 cursor-pointer pb-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? (
                <LuLoaderCircle className="size-5 animate-spin" />
              ) : (
                <LuSend className="size-5" />
              )}
            </button>
          </div>
          <p className="text-muted/70 mt-1 text-[11px]">
            Sends as <span className="font-medium">{me?.displayName ?? "the agent's bot"}</span> ·
            markdown editor · Ctrl/⌘+Enter to send
          </p>
        </div>
      </section>

      {/* Right-click menu, anchored to an invisible element at the cursor —
          same pattern as the agent cards. */}
      <Dropdown isOpen={menu !== null} onOpenChange={(o) => !o && setMenu(null)}>
        <Button
          aria-hidden="true"
          excludeFromTabOrder
          style={{
            position: 'fixed',
            left: menu?.x ?? 0,
            top: menu?.y ?? 0,
            width: 0,
            height: 0,
            minHeight: 0,
            padding: 0,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
        <Dropdown.Popover placement="bottom start" className="min-w-44">
          <Dropdown.Menu onAction={(key) => onMenuAction(String(key))}>
            <Dropdown.Section>
              <Dropdown.Item id="reply" textValue="Reply">
                <span className="flex items-center justify-center">
                  <LuCornerUpLeft className="text-muted size-4 shrink-0" />
                </span>
                <Label>Reply</Label>
              </Dropdown.Item>
              <Dropdown.Item id="react:👍" textValue="React thumbs up">
                <span className="flex items-center justify-center">
                  <LuSmile className="text-muted size-4 shrink-0" />
                </span>
                <Label>React 👍</Label>
              </Dropdown.Item>
              <Dropdown.Item id="react:✅" textValue="React check">
                <span className="flex items-center justify-center">
                  <LuSmile className="text-muted size-4 shrink-0" />
                </span>
                <Label>React ✅</Label>
              </Dropdown.Item>
            </Dropdown.Section>
            <Dropdown.Section>
              <Dropdown.Item id="copy" textValue="Copy text">
                <span className="flex items-center justify-center">
                  <LuCopy className="text-muted size-4 shrink-0" />
                </span>
                <Label>Copy text</Label>
              </Dropdown.Item>
              <Dropdown.Item id="copyId" textValue="Copy message ID">
                <span className="flex items-center justify-center">
                  <LuCopy className="text-muted size-4 shrink-0" />
                </span>
                <Label>Copy message ID</Label>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <AnimatePresence>
        {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
      </AnimatePresence>
    </div>
  );
}
