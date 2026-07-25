'use client';

import { Button, buttonVariants, Input, Label, ListBox, Select, Switch } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuChevronLeft, LuSearch, LuShieldAlert, LuX } from 'react-icons/lu';
import {
  getAuditMeta,
  listAgents,
  listAudit,
  listIpNames,
  normalizeIp,
  streamAudit,
  formatAuditTimestamp,
  type Agent,
  type AuditEvent,
  type AuditFilters,
  type AuditMeta,
} from '@/lib/gateway';

/** Sentinel id for a Select's "all" option — HeroUI Select items can't use ''. */
const ALL = '__all__';
const CATEGORIES = [
  'auth',
  'agent',
  'docker',
  'swarm',
  'integration',
  'settings',
  'file',
  'system',
] as const;
const LEVELS = ['info', 'warn', 'error'] as const;
const ACTORS = ['operator', 'agent', 'system'] as const;
/** Static-query time windows (hours); 0 = all of the in-memory window. */
const RANGES: { key: string; label: string; hours: number }[] = [
  { key: '1', label: 'Last hour', hours: 1 },
  { key: '6', label: 'Last 6 hours', hours: 6 },
  { key: '24', label: 'Last 24 hours', hours: 24 },
  { key: '168', label: 'Last 7 days', hours: 168 },
  { key: '0', label: 'All', hours: 0 },
];
const TIMEZONES = [
  'America/Toronto',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'UTC',
  'Europe/London',
  'Asia/Shanghai',
  'Asia/Tokyo',
];

/** Tailwind color for a level (Minecraft-ish: warn amber, error red). */
function levelColor(level: string | undefined): string {
  return level === 'error' ? 'text-danger' : level === 'warn' ? 'text-warning' : 'text-accent';
}
/** `operator@1.2.3.4`, or `operator@home` when the IP has been named in
 *  Settings → Known IPs. */
function actorLabel(ev: AuditEvent, names: Record<string, string>): string {
  const a = ev.actor;
  if (!a) return 'system';
  const at = a.ip ? `@${names[normalizeIp(a.ip)] ?? a.ip}` : '';
  if (a.kind === 'operator') return `operator${at}`;
  if (a.kind === 'agent') return `${a.name ?? a.id ?? 'agent'}${at}`;
  return 'system';
}

/** A tiny dropdown built on HeroUI Select, with an "All" sentinel. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <Select
      className="w-full min-w-0 sm:w-auto sm:min-w-[8.5rem]"
      value={value || ALL}
      onChange={(v) => {
        const k = String(v ?? ALL);
        onChange(k === ALL ? '' : k);
      }}
    >
      <Label className="text-muted text-xs">{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id={ALL} textValue="All">
            All
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** One Minecraft-style log line (expandable to show structured meta). */
function LogRow({ ev, tz, names }: { ev: AuditEvent; tz: string; names: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!ev.meta && Object.keys(ev.meta).length > 0;
  // Legacy events persisted before the level fix can lack `level`/`category`;
  // default them so rendering never throws on `.toUpperCase()`.
  const level = ev.level ?? 'info';
  const category = ev.category ?? 'system';
  return (
    <div className="border-separator/40 border-b last:border-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`hover:bg-surface-secondary/40 flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-left font-mono text-xs leading-relaxed ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className="text-muted shrink-0 tabular-nums">
          [{formatAuditTimestamp(ev.ts, tz)}]
        </span>
        <span className={`shrink-0 ${levelColor(level)}`}>
          [{category.toUpperCase()}/{level.toUpperCase()}]
        </span>
        <span className="text-muted shrink-0" title={ev.actor?.ip ?? undefined}>
          ({actorLabel(ev, names)})
        </span>
        {/* On phones the message drops to its own line under the prefix; inline on sm+. */}
        <span className="text-foreground basis-full break-words sm:min-w-0 sm:flex-1 sm:basis-auto">
          {ev.message}
        </span>
        {typeof ev.durationMs === 'number' && (
          <span className="text-muted shrink-0">{ev.durationMs}ms</span>
        )}
      </button>
      {open && hasDetail && (
        <pre className="bg-surface-secondary/50 text-muted mx-3 mb-1 overflow-x-auto rounded px-2 py-1 text-[11px] leading-relaxed">
          {JSON.stringify({ agentId: ev.agentId, target: ev.target, ...ev.meta }, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function LogsPage() {
  const [meta, setMeta] = useState<AuditMeta | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tz, setTz] = useState('America/Toronto');
  const [live, setLive] = useState(true);
  /** Known-IP names, so actors render as `operator@home` where recognized. */
  const [ipNames, setIpNames] = useState<Record<string, string>>({});

  // Filters.
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState('');
  const [actor, setActor] = useState('');
  const [agentId, setAgentId] = useState('');
  const [range, setRange] = useState('24');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Preselect ?agent=<id> when deep-linked from an agent.
  useEffect(() => {
    const a = new URLSearchParams(window.location.search).get('agent');
    if (a) setAgentId(a);
  }, []);

  useEffect(() => {
    void getAuditMeta()
      .then((m) => {
        setMeta(m);
        setTz(m.timezone || 'America/Toronto');
      })
      .catch(() => {});
    void listAgents()
      .then(setAgents)
      .catch(() => {});
    void listIpNames()
      .then((rows) => {
        const map: Record<string, string> = {};
        for (const r of rows) map[normalizeIp(r.ip)] = r.name;
        setIpNames(map);
      })
      .catch(() => {}); // cosmetic — raw IPs are a fine fallback
  }, []);

  // Debounce the free-text search.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filters: AuditFilters = useMemo(
    () => ({
      category: (category || undefined) as AuditFilters['category'],
      level: (level || undefined) as AuditFilters['level'],
      actor: (actor || undefined) as AuditFilters['actor'],
      agentId: agentId || undefined,
      q: qDebounced || undefined,
    }),
    [category, level, actor, agentId, qDebounced],
  );
  const filterKey = JSON.stringify(filters);

  // Live tail (stream) or static query, depending on `live`.
  useEffect(() => {
    setError(null);
    if (live) {
      setEvents([]);
      atBottomRef.current = true;
      const ctrl = new AbortController();
      streamAudit(
        { ...filters, limit: 400 },
        (ev) => {
          setEvents((prev) => {
            const next = prev.length > 4000 ? prev.slice(prev.length - 3000) : prev.slice();
            next.push(ev);
            return next;
          });
        },
        ctrl.signal,
      ).catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'stream failed');
      });
      return () => ctrl.abort();
    }
    // Static, newest-first query (refreshed every 5s).
    let alive = true;
    const hours = RANGES.find((r) => r.key === range)?.hours ?? 24;
    const run = () =>
      listAudit({
        ...filters,
        from: hours ? Date.now() - hours * 3_600_000 : undefined,
        limit: 500,
      })
        .then((r) => {
          if (alive) setEvents(r.events);
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : 'query failed'));
    void run();
    const t = setInterval(run, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [live, filterKey, range, filters]);

  // Auto-scroll the live tail to the bottom on new events (if already there).
  useEffect(() => {
    if (live && atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [events, live]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // The backend already orders events: live = chronological (newest at the
  // bottom, auto-scrolled); static = newest-first (newest at the top).
  const rows = events;

  return (
    <main className="mx-auto flex h-[100dvh] max-w-5xl flex-col px-3 py-4 sm:px-4 sm:py-6">
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/" className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}>
          <LuChevronLeft className="size-4" />
          Dashboard
        </Link>
        <h1 className="text-xl font-semibold sm:text-2xl">Logs</h1>
        <Link
          href="/logs/auth"
          className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}
        >
          <LuShieldAlert className="size-4" />
          Auth attempts
        </Link>
        <div className="ml-auto">
          <Switch isSelected={live} onChange={setLive}>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <Label className="text-sm">Live</Label>
            </Switch.Content>
          </Switch>
        </div>
      </header>

      {/* Filter bar: 2-col grid on phones, flex row on sm+. */}
      <div className="mb-3 grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
        <FilterSelect
          label="Timezone"
          value={tz}
          onChange={(v) => setTz(v || 'America/Toronto')}
          options={TIMEZONES.map((t) => ({ id: t, label: t }))}
        />
        <FilterSelect
          label="Category"
          value={category}
          onChange={setCategory}
          options={CATEGORIES.map((c) => ({
            id: c,
            label: `${c}${meta?.byCategory[c] ? ` (${meta.byCategory[c]})` : ''}`,
          }))}
        />
        <FilterSelect
          label="Level"
          value={level}
          onChange={setLevel}
          options={LEVELS.map((l) => ({ id: l, label: l }))}
        />
        <FilterSelect
          label="Actor"
          value={actor}
          onChange={setActor}
          options={ACTORS.map((a) => ({ id: a, label: a }))}
        />
        <FilterSelect
          label="Agent"
          value={agentId}
          onChange={setAgentId}
          options={agents.map((a) => ({ id: a.id, label: a.username || a.id }))}
        />
        {!live && (
          <Select
            className="w-full sm:w-auto sm:min-w-[8.5rem]"
            value={range}
            onChange={(v) => setRange(String(v ?? '24'))}
          >
            <Label className="text-muted text-xs">Range</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {RANGES.map((r) => (
                  <ListBox.Item key={r.key} id={r.key} textValue={r.label}>
                    {r.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        )}
        <div className="relative col-span-2 min-w-[12rem] sm:col-auto sm:flex-1">
          <Label className="text-muted text-xs">Search</Label>
          <div className="relative">
            <LuSearch className="text-muted pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2" />
            <Input
              placeholder="Filter by text…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              className="w-full pl-8"
            />
          </div>
        </div>
        {(category || level || actor || agentId || q) && (
          <Button
            size="sm"
            variant="tertiary"
            className="col-span-2 gap-1 sm:col-auto"
            onPress={() => {
              setCategory('');
              setLevel('');
              setActor('');
              setAgentId('');
              setQ('');
            }}
          >
            <LuX className="size-3.5" /> Clear
          </Button>
        )}
      </div>

      {error && <p className="text-danger mb-2 text-sm">{error}</p>}

      {/* Log list */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="border-separator min-h-0 flex-1 overflow-auto rounded-lg border bg-black/[0.015] dark:bg-white/[0.02]"
      >
        {rows.length === 0 ? (
          <p className="text-muted p-8 text-center text-sm">
            {live ? 'Waiting for events…' : 'No events match these filters.'}
          </p>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {rows.map((ev) => (
              <LogRow key={ev.id} ev={ev} tz={tz} names={ipNames} />
            ))}
          </motion.div>
        )}
      </div>
      <p className="text-muted mt-2 text-xs">
        {live ? 'Live tail' : 'Snapshot'} · {rows.length} event{rows.length === 1 ? '' : 's'}
        {meta ? ` · ${meta.total} in window` : ''} · times in {tz}
      </p>
    </main>
  );
}
