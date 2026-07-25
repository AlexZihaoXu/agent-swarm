'use client';

import { Button, buttonVariants, Input, Label, ListBox, Select, TextField } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LuChevronLeft, LuCheck, LuScrollText, LuShieldAlert, LuTag } from 'react-icons/lu';
import {
  listAudit,
  listIpNames,
  updateIpNames,
  normalizeIp,
  formatAuditTimestamp,
  type AuditEvent,
  type IpNameEntry,
} from '@/lib/gateway';

/** Static-query time windows (hours); 0 = everything still in the ring. */
const RANGES: { key: string; label: string; hours: number }[] = [
  { key: '24', label: 'Last 24 hours', hours: 24 },
  { key: '168', label: 'Last 7 days', hours: 168 },
  { key: '720', label: 'Last 30 days', hours: 720 },
  { key: '0', label: 'All', hours: 0 },
];

const OUTCOMES = [
  { key: 'all', label: 'All attempts' },
  { key: 'bad', label: 'Failed & blocked' },
  { key: 'good', label: 'Successful' },
] as const;

type Outcome = 'success' | 'fail' | 'block' | 'info';

/** Classify an auth event into the four buckets this page cares about. The
 *  action strings are the ones emitted by handleAuth() + the login throttle. */
function outcomeOf(action: string | undefined): Outcome {
  switch (action) {
    case 'auth.login.success':
    case 'auth.password.change':
    case 'auth.setup':
      return 'success';
    case 'auth.login.fail':
    case 'auth.password.fail':
      return 'fail';
    case 'auth.login.throttled':
    case 'auth.breaker.trip':
      return 'block';
    default:
      return 'info'; // auth.logout, and anything added later
  }
}

const OUTCOME_STYLE: Record<Outcome, { label: string; cls: string }> = {
  success: { label: 'OK', cls: 'text-accent' },
  fail: { label: 'FAILED', cls: 'text-danger' },
  block: { label: 'BLOCKED', cls: 'text-warning' },
  info: { label: 'INFO', cls: 'text-muted' },
};

/** One attempt. Unknown IPs get a "name it" affordance inline, because naming
 *  the address you just saw is the whole point of the known-IP map. */
function AttemptRow({
  ev,
  tz,
  names,
  onNamed,
}: {
  ev: AuditEvent;
  tz: string;
  names: Record<string, string>;
  onNamed: (ip: string, name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);

  const ip = normalizeIp(ev.actor?.ip ?? '');
  const known = ip ? names[ip] : undefined;
  const outcome = outcomeOf(ev.action);
  const style = OUTCOME_STYLE[outcome];

  const commit = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await onNamed(ip, draft.trim());
      setNaming(false);
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-separator/40 border-b px-3 py-1.5 font-mono text-xs leading-relaxed last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-muted shrink-0 tabular-nums">
          [{formatAuditTimestamp(ev.ts, tz)}]
        </span>
        <span className={`shrink-0 font-semibold ${style.cls}`}>[{style.label}]</span>
        {ip ? (
          known ? (
            <span className="text-accent shrink-0" title={ip}>
              {known}
            </span>
          ) : (
            <span className="text-warning shrink-0" title="This address has no name yet">
              {ip} <span className="opacity-70">(unknown)</span>
            </span>
          )
        ) : (
          <span className="text-muted shrink-0">no ip</span>
        )}
        <span className="text-foreground basis-full break-words sm:min-w-0 sm:flex-1 sm:basis-auto">
          {ev.message}
        </span>
        {ip && !known && !naming && (
          <Button
            size="sm"
            variant="tertiary"
            className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
            onPress={() => setNaming(true)}
          >
            <LuTag className="size-3" />
            Name it
          </Button>
        )}
      </div>
      {naming && (
        <div className="mt-1.5 flex items-center gap-2">
          <TextField
            className="w-44"
            aria-label={`Name for ${ip}`}
            value={draft}
            onChange={setDraft}
            autoFocus
          >
            <Input
              className="h-7 text-xs"
              placeholder="home"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit();
                if (e.key === 'Escape') setNaming(false);
              }}
            />
          </TextField>
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            isDisabled={!draft.trim() || busy}
            onPress={() => void commit()}
          >
            <LuCheck className="size-3" />
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            className="h-7 px-2 text-[11px]"
            onPress={() => setNaming(false)}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Auth attempts — every login, password change, and throttle/lockout the
 * gateway recorded, with the source IP resolved through the known-IP map so an
 * unfamiliar location is obvious at a glance. Read-only view over the same
 * audit log the /logs page tails, narrowed to category=auth.
 */
export default function AuthAttemptsPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [rawNames, setRawNames] = useState<IpNameEntry[]>([]);
  const [tz, setTz] = useState('America/Toronto');
  const [range, setRange] = useState('168');
  const [outcome, setOutcome] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refreshNames = useCallback(async () => {
    try {
      const rows = await listIpNames();
      setRawNames(rows);
      const map: Record<string, string> = {};
      for (const r of rows) map[normalizeIp(r.ip)] = r.name;
      setNames(map);
    } catch {
      /* the map is cosmetic — a failure here shouldn't blank the page */
    }
  }, []);

  useEffect(() => {
    void refreshNames();
  }, [refreshNames]);

  // Poll the audit log, newest-first, narrowed to auth events.
  useEffect(() => {
    let alive = true;
    const hours = RANGES.find((r) => r.key === range)?.hours ?? 168;
    const run = () =>
      listAudit({
        category: 'auth',
        from: hours ? Date.now() - hours * 3_600_000 : undefined,
        limit: 500,
      })
        .then((r) => {
          if (!alive) return;
          setEvents(r.events);
          setTz(r.timezone || 'America/Toronto');
          setLoaded(true);
          setError(null);
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : 'query failed'));
    void run();
    const t = setInterval(run, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [range]);

  const nameIp = useCallback(
    async (ip: string, name: string) => {
      const next = [...rawNames.filter((r) => normalizeIp(r.ip) !== ip), { ip, name }];
      await updateIpNames(next);
      await refreshNames();
    },
    [rawNames, refreshNames],
  );

  const rows = useMemo(
    () =>
      events.filter((ev) => {
        const o = outcomeOf(ev.action);
        if (outcome === 'bad') return o === 'fail' || o === 'block';
        if (outcome === 'good') return o === 'success';
        return true;
      }),
    [events, outcome],
  );

  // Summary over the whole window (not the outcome filter) — the headline
  // numbers should not move when you flip the filter.
  const stats = useMemo(() => {
    const ips = new Set<string>();
    const unknown = new Set<string>();
    let failed = 0;
    for (const ev of events) {
      const o = outcomeOf(ev.action);
      if (o === 'fail' || o === 'block') failed++;
      const ip = normalizeIp(ev.actor?.ip ?? '');
      if (!ip) continue;
      ips.add(ip);
      if (!names[ip]) unknown.add(ip);
    }
    return { total: events.length, failed, ips: ips.size, unknown: unknown.size };
  }, [events, names]);

  return (
    <main className="mx-auto flex h-[100dvh] max-w-5xl flex-col px-3 py-4 sm:px-4 sm:py-6">
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/" className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}>
          <LuChevronLeft className="size-4" />
          Dashboard
        </Link>
        <h1 className="text-xl font-semibold sm:text-2xl">Auth attempts</h1>
        <Link
          href="/logs"
          className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} ml-auto gap-1.5`}
        >
          <LuScrollText className="size-4" />
          All logs
        </Link>
      </header>

      {/* Summary strip */}
      <div className="border-separator mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 border p-3 text-sm">
        <span>
          <span className="font-semibold tabular-nums">{stats.total}</span>{' '}
          <span className="text-muted">attempts</span>
        </span>
        <span className={stats.failed ? 'text-danger' : ''}>
          <span className="font-semibold tabular-nums">{stats.failed}</span>{' '}
          <span className={stats.failed ? '' : 'text-muted'}>failed / blocked</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums">{stats.ips}</span>{' '}
          <span className="text-muted">distinct IPs</span>
        </span>
        <span className={stats.unknown ? 'text-warning' : ''}>
          <span className="font-semibold tabular-nums">{stats.unknown}</span>{' '}
          <span className={stats.unknown ? '' : 'text-muted'}>unnamed</span>
        </span>
        <Link
          href="/settings"
          className="text-muted hover:text-foreground ml-auto text-xs underline underline-offset-2"
        >
          Manage known IPs
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-3 grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
        <Select
          className="w-full min-w-0 sm:w-auto sm:min-w-[9.5rem]"
          value={range}
          onChange={(v) => setRange(String(v ?? '168'))}
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
        <Select
          className="w-full min-w-0 sm:w-auto sm:min-w-[9.5rem]"
          value={outcome}
          onChange={(v) => setOutcome(String(v ?? 'all'))}
        >
          <Label className="text-muted text-xs">Outcome</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {OUTCOMES.map((o) => (
                <ListBox.Item key={o.key} id={o.key} textValue={o.label}>
                  {o.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {error && <p className="text-danger mb-2 text-sm">{error}</p>}

      <div className="border-separator min-h-0 flex-1 overflow-y-auto border">
        {loaded && rows.length === 0 && (
          <div className="text-muted flex flex-col items-center gap-2 py-10 text-sm">
            <LuShieldAlert className="size-6 opacity-50" />
            No auth activity in this window.
          </div>
        )}
        {!loaded && <p className="text-muted p-3 text-sm">Loading…</p>}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {rows.map((ev) => (
            <AttemptRow key={ev.id} ev={ev} tz={tz} names={names} onNamed={nameIp} />
          ))}
        </motion.div>
      </div>

      <p className="text-muted mt-2 text-xs">
        {rows.length} shown · refreshes every 5s · retained for as long as the audit ring holds
        them.
      </p>
    </main>
  );
}
