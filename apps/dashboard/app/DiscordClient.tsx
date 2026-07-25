'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuHash, LuLoaderCircle, LuMessagesSquare, LuSend, LuUser } from 'react-icons/lu';
import {
  DISCORD_CATEGORY,
  discordChannels,
  discordGuilds,
  discordMessages,
  discordOpenDm,
  discordSend,
  discordWhoami,
  listIntegrations,
  type DiscordAuthor,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMessage,
} from '@/lib/gateway';

/** How often an open channel re-polls. The bridge has no operator-facing push
 *  stream, so this is a plain interval — cheap, since Discord returns ≤50 rows. */
const POLL_MS = 5_000;
/** Consecutive messages from one author inside this window render as one block
 *  (avatar + name once), which is most of what makes it read like Discord. */
const GROUP_WINDOW_MS = 5 * 60_000;

type Target =
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'dm'; id: string; name: string; userId: string };

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today at ${time}` : `${d.toLocaleDateString()} ${time}`;
}

/** Discord renders newest at the bottom; the API returns newest-first. */
function chronological(msgs: DiscordMessage[]): DiscordMessage[] {
  return [...msgs].reverse();
}

function MessageBlock({ msg, grouped }: { msg: DiscordMessage; grouped: boolean }) {
  return (
    <div className={`hover:bg-surface-secondary/40 px-4 ${grouped ? 'py-0.5' : 'mt-4 py-0.5'}`}>
      {msg.replyTo && (
        <div className="text-muted mb-1 flex items-center gap-1.5 pl-12 text-xs">
          <span className="border-separator ml-[-1.5rem] h-3 w-6 rounded-tl border-t border-l" />
          <span className="font-medium">{msg.replyTo.author}</span>
          <span className="truncate opacity-80">{msg.replyTo.content || '(no text)'}</span>
        </div>
      )}
      <div className="flex gap-3">
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
            <div className="flex items-baseline gap-2">
              <span className="text-foreground text-sm font-medium">{msg.author.displayName}</span>
              {msg.author.bot && (
                <span className="bg-accent text-accent-foreground rounded px-1 py-px text-[10px] font-semibold">
                  BOT
                </span>
              )}
              <span className="text-muted text-xs">{timeLabel(msg.timestamp)}</span>
            </div>
          )}
          {msg.content && (
            <p className="text-foreground/90 text-sm leading-relaxed break-words whitespace-pre-wrap">
              {msg.content}
            </p>
          )}
          {msg.attachments.map((a) =>
            a.contentType?.startsWith('image/') ? (
              <img
                key={a.id}
                src={a.url}
                alt={a.filename}
                className="border-separator mt-1 max-h-80 max-w-full rounded border"
                loading="lazy"
              />
            ) : (
              <a
                key={a.id}
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent mt-1 block text-sm underline"
              >
                {a.filename}
              </a>
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
    </div>
  );
}

/**
 * A Discord client scoped to one agent's bot: read history and post as that
 * agent. Laid out like Discord on purpose (guild rail → channel sidebar →
 * messages → composer) so it's navigable without relearning anything.
 *
 * Two deliberate omissions, both hard limits rather than shortcuts:
 *  - No member list. It needs the privileged Server Members intent, which the
 *    bridge doesn't request, so the panel would always be empty.
 *  - DMs can't be enumerated: bots get an empty list from Discord. The DM
 *    section is seeded from the integration's `allowedUserIds` instead, which
 *    is the set of humans allowed to DM this agent anyway.
 */
export function DiscordClient({ agentId }: { agentId: string }) {
  const [me, setMe] = useState<DiscordAuthor | null>(null);
  const [guilds, setGuilds] = useState<DiscordGuild[]>([]);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [dmUsers, setDmUsers] = useState<string[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [messages, setMessages] = useState<DiscordMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Identity, guilds, and the DM allow-list (our only source of DM targets).
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
        const discord = ints.find((i) => i.type === 'discord');
        setDmUsers(discord?.rules?.allowedUserIds ?? []);
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

  // Channels for the selected guild; auto-open the first text channel.
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

  // Poll the open conversation.
  const load = useCallback(async () => {
    if (!target) return;
    try {
      const msgs = await discordMessages(agentId, target.id, { limit: 50, self: me?.id });
      setMessages(chronological(msgs));
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [agentId, target, me?.id]);

  useEffect(() => {
    if (!target) return;
    setMessages([]);
    atBottomRef.current = true;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [target, load]);

  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages]);

  const openDm = async (userId: string) => {
    try {
      const { channelId } = await discordOpenDm(agentId, userId);
      setTarget({ kind: 'dm', id: channelId, name: userId, userId });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || !target || sending) return;
    setSending(true);
    setInput('');
    try {
      await discordSend(agentId, target.id, content);
      atBottomRef.current = true;
      await load();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setInput(content); // don't lose what they typed
    } finally {
      setSending(false);
    }
  };

  // Group text channels under their category, Discord-style. Two channels can
  // share a name in different categories, so the grouping is what makes the
  // sidebar unambiguous.
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

  return (
    <div className="bg-surface flex h-full min-h-0 overflow-hidden">
      {/* Guild rail */}
      <nav className="bg-surface-tertiary flex w-[68px] shrink-0 flex-col items-center gap-2 overflow-y-auto py-3">
        <button
          type="button"
          aria-label="Direct messages"
          onClick={() => setGuildId(null)}
          className={`flex size-12 items-center justify-center rounded-[24px] transition-all hover:rounded-2xl ${
            guildId === null ? 'bg-accent text-accent-foreground rounded-2xl' : 'bg-surface'
          }`}
        >
          <LuMessagesSquare className="size-6" />
        </button>
        <span className="bg-separator h-px w-8 shrink-0" />
        {guilds.map((g) => (
          <button
            key={g.id}
            type="button"
            title={g.name}
            onClick={() => setGuildId(g.id)}
            className={`size-12 shrink-0 overflow-hidden transition-all hover:rounded-2xl ${
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
              {dmUsers.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => void openDm(u)}
                  className={`hover:bg-surface-tertiary mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                    target?.kind === 'dm' && target.userId === u
                      ? 'bg-surface-tertiary text-foreground'
                      : 'text-muted'
                  }`}
                >
                  <LuUser className="size-4 shrink-0" />
                  <span className="truncate font-mono text-xs">{u}</span>
                </button>
              ))}
            </>
          ) : (
            grouped.map((group) => (
              <div key={group.category ?? '_'} className="mb-2">
                {group.category && (
                  <p className="text-muted px-3 py-1 text-[11px] font-semibold tracking-wide uppercase">
                    {group.category}
                  </p>
                )}
                {group.channels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setTarget({ kind: 'channel', id: c.id, name: c.name })}
                    className={`hover:bg-surface-tertiary mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
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
        {/* Bot identity panel, like Discord's user panel */}
        {me && (
          <div className="border-separator bg-surface-tertiary flex items-center gap-2 border-t px-2 py-2">
            <img src={me.avatarUrl} alt="" className="size-8 rounded-full" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{me.displayName}</p>
              <p className="text-muted truncate text-[11px]">posting as this bot</p>
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
        </header>

        {error && (
          <p className="text-danger border-separator border-b px-4 py-2 text-sm">{error}</p>
        )}

        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto pb-4"
        >
          {loading && (
            <div className="text-muted flex items-center justify-center gap-2 py-10 text-sm">
              <LuLoaderCircle className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && target && messages.length === 0 && (
            <div className="text-muted flex flex-col items-center gap-2 py-16 text-sm">
              <LuMessagesSquare className="size-8 opacity-40" />
              No messages here yet.
            </div>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped =
              !!prev &&
              prev.author.id === m.author.id &&
              !m.replyTo &&
              new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() <
                GROUP_WINDOW_MS;
            return <MessageBlock key={m.id} msg={m} grouped={grouped} />;
          })}
        </div>

        <div className="px-4 pb-4">
          <div className="bg-surface-secondary focus-within:border-accent border-separator flex items-end gap-2 rounded-lg border px-3 py-2 transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              disabled={!target || sending}
              placeholder={
                target
                  ? `Message ${target.kind === 'dm' ? '@' : '#'}${target.name}`
                  : 'Select a channel first'
              }
              className="placeholder:text-muted max-h-32 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm outline-none disabled:cursor-not-allowed"
            />
            <button
              type="button"
              aria-label="Send"
              disabled={!input.trim() || !target || sending}
              onClick={() => void send()}
              className="text-muted hover:text-accent shrink-0 transition-colors disabled:opacity-40"
            >
              {sending ? (
                <LuLoaderCircle className="size-5 animate-spin" />
              ) : (
                <LuSend className="size-5" />
              )}
            </button>
          </div>
          <p className="text-muted/70 mt-1 text-[11px]">
            Sends as{' '}
            <span className="font-medium">{me?.displayName ?? 'the agent&apos;s bot'}</span> · Enter
            to send, Shift+Enter for a newline
          </p>
        </div>
      </section>
    </div>
  );
}
