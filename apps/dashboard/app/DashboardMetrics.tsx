'use client';

import { Card, ProgressCircle, Tooltip } from '@heroui/react';
import { animate, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getHostInfo,
  getMetrics,
  getUsage,
  type HostInfo,
  type Metrics,
  type RateWindow,
  type Usage,
} from '@/lib/gateway';
import { useDashboardSettings } from './DashboardSettings';

/** Distinct line colors for per-agent resource graphs (cycled by index). */
const LINE_COLORS = ['#e0a55e', '#7aa2f7', '#9ece6a', '#bb9af7', '#f7768e', '#7dcfff', '#e0af68'];

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}
function fmtClock(t: number): string {
  const d = new Date(t);
  const h = d.getHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'AM' : 'PM'}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtCost(n: number): string {
  return `$${n < 1 ? n.toFixed(2) : n.toFixed(2)}`;
}
function fmtHour(t: number): string {
  const h = new Date(t).getHours();
  // 12-hour clock, no zero-pad: 0→12AM, 1-11→1AM-11AM, 12→12PM, 13-23→1PM-11PM.
  // Compact for the recharts X axis (tick labels are tight).
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${h < 12 ? 'AM' : 'PM'}`;
}
/** Day+hour label for >24h ranges where time-of-day alone is ambiguous (was
 *  today's 3PM or three days ago?). Format: "Mon 3PM". */
function fmtDayHour(t: number): string {
  const d = new Date(t);
  const h = d.getHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const wk = d.toLocaleDateString([], { weekday: 'short' });
  return `${wk} ${hour12}${h < 12 ? 'AM' : 'PM'}`;
}
function resetsIn(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return 'resetting';
  const h = ms / 3_600_000;
  if (h < 1) return `resets in ${Math.round(ms / 60_000)}m`;
  if (h < 24) return `resets in ${Math.round(h)}h`;
  return `resets in ${Math.round(h / 24)}d`;
}

const AXIS = { fontSize: 11, fill: 'var(--muted)' } as const;
const TOOLTIP = {
  background: 'var(--surface)',
  border: '1px solid var(--separator)',
  borderRadius: 8,
  fontSize: 12,
} as const;

/**
 * A rate-limit window (5h / 7d) as a labelled progress circle. Colour comes
 * from PROJECTED end-of-window usage at the current burn rate (linear
 * extrapolation): green = surely safe, orange = dangerously close, red = will
 * exceed. The arc still shows current usage.
 */
function UsageRing({
  label,
  w,
  windowMs,
  outdated,
}: {
  label: string;
  w: RateWindow;
  windowMs: number;
  /** No fresh data for >5m (account idle): grey the ring, drop the projection. */
  outdated: boolean;
}) {
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const elapsedFrac = Math.min(1, Math.max(0, 1 - (w.resetsAt - Date.now()) / windowMs));
  // Project to the reset at the current average rate (ignore the first slice of
  // the window where the rate is too noisy to trust).
  const projected = elapsedFrac > 0.05 ? w.usedPercent / elapsedFrac : w.usedPercent;
  const color = outdated
    ? 'default'
    : projected >= 100
      ? 'danger'
      : projected >= 80
        ? 'warning'
        : 'success';
  return (
    <Tooltip>
      <Tooltip.Trigger className="block">
        <div className="flex items-center gap-3">
          <div className="relative grid place-items-center">
            <ProgressCircle aria-label={`${label} usage`} size="lg" color={color} value={pct}>
              <ProgressCircle.Track>
                <ProgressCircle.TrackCircle />
                <ProgressCircle.FillCircle />
              </ProgressCircle.Track>
            </ProgressCircle>
            <span
              className={`absolute text-xs font-semibold tabular-nums ${outdated ? 'text-muted' : ''}`}
            >
              {Math.round(pct)}%
            </span>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{label}</div>
            <div className="text-muted text-xs">{resetsIn(w.resetsAt)}</div>
            {outdated ? (
              <div className="text-muted/70 text-[11px]">outdated</div>
            ) : (
              <div className="text-muted/70 text-[11px] tabular-nums">
                ~{Math.round(projected)}% projected
              </div>
            )}
          </div>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow>
        <Tooltip.Arrow />
        <div className="min-w-[180px] space-y-1 px-1 py-1.5">
          <div className="text-sm font-semibold">{label}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted">Used</dt>
            <dd className="text-right">{w.usedPercent.toFixed(1)}%</dd>
            {!outdated && (
              <>
                <dt className="text-muted">Projected</dt>
                <dd
                  className={`text-right ${
                    projected >= 100
                      ? 'text-danger'
                      : projected >= 80
                        ? 'text-warning'
                        : 'text-success'
                  }`}
                >
                  ~{projected.toFixed(0)}%
                </dd>
                <dt className="text-muted">Elapsed</dt>
                <dd className="text-right">{(elapsedFrac * 100).toFixed(0)}% of window</dd>
              </>
            )}
            <dt className="text-muted">Resets</dt>
            <dd className="text-right">
              {new Date(w.resetsAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                month: 'short',
                day: 'numeric',
              })}
            </dd>
          </dl>
          {outdated && (
            <p className="text-muted/80 mt-1 text-[11px]">
              No fresh data for &gt;5m (account idle). Projection paused.
            </p>
          )}
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}

/** Smoothly ease a displayed number toward each new target (no sudden jumps). */
function useLerp(value: number, duration = 0.45): number {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const controls = animate(prev.current, value, {
      duration,
      ease: 'easeOut',
      onUpdate: (v) => setShown(v),
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, duration]);
  return shown;
}

/** A number whose displayed value lerps to each new target — drop-in replacement
 *  for `{format(value)}`. Used inside the metrics tooltips so changing values
 *  ease instead of flashing every 500ms-poll cycle. */
function LerpNum({
  value,
  format,
  duration = 0.6,
}: {
  value: number;
  format: (v: number) => string;
  duration?: number;
}) {
  const shown = useLerp(value, duration);
  return <>{format(shown)}</>;
}

/** A per-agent breakdown list with framer-motion `layout` animation: when the
 *  sort order changes (because an agent's CPU% or memory crosses someone else),
 *  the rows glide to their new positions instead of snapping. Color tone +
 *  numeric value also transition smoothly. */
function PerAgentList<T extends { id: string; name: string }>({
  items,
  sortBy,
  format,
  tone,
}: {
  items: T[];
  /** Larger first. */
  sortBy: (item: T) => number;
  format: (item: T) => React.ReactNode;
  tone?: (item: T) => string;
}) {
  const sorted = [...items].sort((a, b) => sortBy(b) - sortBy(a));
  return (
    <motion.ul
      layout
      className="space-y-0.5 text-xs tabular-nums"
      transition={{ layout: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } }}
    >
      {sorted.map((a) => (
        <motion.li
          key={a.id}
          layout="position"
          transition={{ layout: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } }}
          className="flex justify-between gap-3"
        >
          <span className="truncate">{a.name}</span>
          <motion.span
            // Animate color smoothly when the agent crosses a tier threshold.
            // tailwind colors aren't keyframable directly, but switching the
            // class triggers CSS transitions on `color` — declared below.
            className={`transition-colors duration-300 ${tone ? tone(a) : 'text-foreground'}`}
          >
            {format(a)}
          </motion.span>
        </motion.li>
      ))}
    </motion.ul>
  );
}

/** Live resource ring (CPU / memory): a progress circle filled to value/max with
 *  a lerped %, plus a label + sub-line. Colour tracks utilization. The ring is
 *  wrapped in a HeroUI Tooltip; pass `detail` to render formatted breakdown
 *  (per-agent contributions, host totals, etc.) on hover. */
function LiveRing({
  label,
  value,
  max,
  format,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  /** Sub-line text from the lerped value (so it eases, not jumps). */
  format: (shown: number) => string;
  /** Tooltip body content. Receives the live (un-lerped) value + max so the
   *  hover state stays in sync with the headline number — not the eased one. */
  detail?: (ctx: { value: number; max: number; pct: number }) => React.ReactNode;
}) {
  const shown = useLerp(value);
  const pct = max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0;
  const livePct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = pct >= 85 ? 'danger' : pct >= 60 ? 'warning' : 'success';
  return (
    <Tooltip>
      <Tooltip.Trigger className="block">
        <div className="flex items-center gap-3">
          <div className="relative grid place-items-center">
            <ProgressCircle aria-label={`${label} usage`} size="lg" color={color} value={pct}>
              <ProgressCircle.Track>
                <ProgressCircle.TrackCircle />
                <ProgressCircle.FillCircle />
              </ProgressCircle.Track>
            </ProgressCircle>
            <span className="absolute text-xs font-semibold tabular-nums">{Math.round(pct)}%</span>
          </div>
          {/* Fixed width so a changing value (e.g. "969 MB" → "1.1 GB") never reflows. */}
          <div className="w-20">
            <div className="text-sm font-semibold">{label}</div>
            <div className="text-muted text-xs tabular-nums">{format(shown)}</div>
          </div>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow>
        <Tooltip.Arrow />
        <div className="min-w-[200px] space-y-1 px-1 py-1.5">
          <div className="text-sm font-semibold">{label}</div>
          {detail ? (
            detail({ value, max, pct: livePct })
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
              <dt className="text-muted">Used</dt>
              <dd className="text-right">{livePct.toFixed(1)}%</dd>
            </dl>
          )}
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * Always-on usage overview: 5h/7d rate-limit rings, per-agent 24h tokens, and
 * total tokens + money spent over the last 24h. Polls every 30s.
 */
export function DashboardMetrics() {
  const [m, setM] = useState<Metrics | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);
  // Right-click settings (range + per-chart toggles) live on the page-level
  // provider so the same menu opens anywhere on the dashboard, not just over
  // a chart. Each chart reads its preferences from this hook.
  const { rangeHours, rangeLabel, tokensSortBy, showCostLine, smoothResource } =
    useDashboardSettings();

  // Host capacity = the ceiling for the resource graphs. CPU/RAM are fixed, but
  // disk usage drifts, so re-poll (slowly — it changes gradually).
  useEffect(() => {
    let alive = true;
    const load = () =>
      getHostInfo()
        .then((h) => alive && setHost(h))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getMetrics(rangeHours)
        .then((d) => alive && setM(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [rangeHours]);

  // Live resource usage for the headline numbers. Recursive timeout (not
  // setInterval) with the next tick scheduled only after the previous settles,
  // so a slow poll can't stack up — the old 500ms interval fired 2×/s and each
  // call hits the gateway's docker.listContainers, so bursts piled up whenever
  // the event loop stalled. 2s is ample (the gateway samples cpu/mem ~1/s).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      getUsage()
        .then((u) => alive && setUsage(u))
        .catch(() => {})
        .finally(() => {
          if (alive) timer = setTimeout(tick, 2000);
        });
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  if (!m) return null;
  // Collapse same-named agents (an agent recreated under the same display name
  // leaves two ids) so the bar chart shows one bar per name, summed.
  const tokenByName = new Map<string, { name: string; tokens: number; cost: number }>();
  for (const a of m.agents) {
    if (a.tokens <= 0) continue;
    const cur = tokenByName.get(a.name);
    if (cur) {
      cur.tokens += a.tokens;
      cur.cost += a.cost;
    } else tokenByName.set(a.name, { name: a.name, tokens: a.tokens, cost: a.cost });
  }
  const perAgent = [...tokenByName.values()].sort((a, b) =>
    tokensSortBy === 'name' ? a.name.localeCompare(b.name) : b.tokens - a.tokens,
  );
  // Bucket label format depends on range: hours (12h/24h), weekday+hour (3d),
  // or day-of-month (7d). Keeps the X axis legible without crowding.
  const bucketLabel = rangeHours <= 24 ? fmtHour : fmtDayHour;
  const overTime = m.buckets.map((b) => ({
    label: bucketLabel(b.t),
    tokens: b.tokens,
    cost: b.cost,
  }));
  // Same for the resource charts' time axis (CPU / Memory), whose X ticks are
  // numeric epoch ms (scale="time") — pick a formatter for the chosen range.
  const resourceTick = rangeHours <= 24 ? fmtClock : fmtDayHour;

  const totalTokens = m.agents.reduce((s, a) => s + a.tokens, 0);
  const totalCost = m.agents.reduce((s, a) => s + a.cost, 0);

  // Per-agent series → recharts rows keyed by agent name. We also walk the
  // points to find the actual per-series peak so the Y axis can scale to the
  // data instead of the host ceiling — no single agent uses 16 cores or 24 GB,
  // so a host-pegged axis leaves the lines hugging the floor.
  const series = m.usage.series;
  let cpuPeak = 0;
  let memPeak = 0; // MB
  const cpuData = m.usage.points.map((p) => {
    const row: Record<string, number> = { t: p.t };
    for (const s of series) {
      const v = p.cpu[s.id] ?? 0;
      row[s.name] = v;
      if (v > cpuPeak) cpuPeak = v;
    }
    return row;
  });
  const memData = m.usage.points.map((p) => {
    const row: Record<string, number> = { t: p.t };
    for (const s of series) {
      const mb = Math.round((p.mem[s.id] ?? 0) / (1 << 20));
      row[s.name] = mb;
      if (mb > memPeak) memPeak = mb;
    }
    return row;
  });
  // Round each peak up to the next integer step (100% for CPU, 1 GB for
  // memory) so the Y axis ticks are clean whole values: 100/200/300% or
  // 1/2/3/4 GB. Always at least one full step so the axis isn't flat.
  const cpuMax = Math.max(100, Math.ceil(cpuPeak / 100) * 100);
  const cpuTicks: number[] = [];
  for (let v = 0; v <= cpuMax; v += 100) cpuTicks.push(v);
  const memMaxGb = Math.max(1, Math.ceil(memPeak / 1024));
  const memMax = memMaxGb * 1024;
  const memTicks: number[] = [];
  for (let g = 0; g <= memMaxGb; g++) memTicks.push(g * 1024);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="mb-6"
    >
      <Card>
        <Card.Content className="space-y-3">
          {/* Rate-limit + resource rings, then 12h totals. On phones the rings sit
              in a 2-col grid (uniform gap, top-aligned so the taller rate rings
              don't skew spacing); on lg+ the rings group takes the remaining width
              (flex-1) so every ring — including Disk — stays on one inline row with
              the totals pushed to the right. */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-x-8">
            <div className="grid grid-cols-2 items-start gap-4 sm:flex sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-4 lg:flex-1 lg:flex-nowrap lg:gap-x-6">
              {m.rateLimits ? (
                (() => {
                  const outdated = Date.now() - m.rateLimits.updatedAt > 5 * 60_000;
                  return (
                    <>
                      <UsageRing
                        label="5h window"
                        w={m.rateLimits.fiveHour}
                        windowMs={5 * 3_600_000}
                        outdated={outdated}
                      />
                      <UsageRing
                        label="7d window"
                        w={m.rateLimits.sevenDay}
                        windowMs={7 * 86_400_000}
                        outdated={outdated}
                      />
                    </>
                  );
                })()
              ) : (
                <span className="text-muted col-span-2 text-sm">No usage data yet.</span>
              )}

              {/* Divider between the rate-limit rings and the resource rings: a
                  full-width horizontal rule across the 2-col grid on phones, a
                  vertical hairline when the rings are inline (sm+). */}
              <div className="bg-separator col-span-2 my-0.5 h-px w-full sm:my-0 sm:h-10 sm:w-px" />
              <LiveRing
                label="CPU"
                value={usage?.cpuPct ?? 0}
                max={host ? host.cpus * 100 : 100}
                format={() => (host ? `${host.cpus} cores` : '')}
                detail={({ value, max, pct }) => (
                  <>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
                      <dt className="text-muted">Used</dt>
                      <dd className="text-right">
                        <LerpNum value={pct} format={(v) => `${v.toFixed(1)}% of host`} />
                      </dd>
                      <dt className="text-muted">Busy</dt>
                      <dd className="text-right">
                        <LerpNum value={value} format={(v) => (v / 100).toFixed(2)} /> /{' '}
                        {(max / 100).toFixed(0)} cores
                      </dd>
                    </dl>
                    {usage && usage.agents.length > 0 && (
                      <div className="border-separator/40 mt-2 border-t pt-1.5">
                        <div className="text-muted/80 mb-1 text-[10px] tracking-wide uppercase">
                          Per agent
                        </div>
                        <PerAgentList
                          items={usage.agents}
                          sortBy={(a) => a.cpuPct}
                          format={(a) => (
                            <LerpNum value={a.cpuPct} format={(v) => `${v.toFixed(1)}%`} />
                          )}
                          tone={(a) =>
                            a.cpuPct >= 100
                              ? 'text-warning'
                              : a.cpuPct >= 50
                                ? 'text-foreground'
                                : 'text-muted'
                          }
                        />
                      </div>
                    )}
                  </>
                )}
              />
              <LiveRing
                label="Memory"
                value={usage?.memUsed ?? 0}
                max={host ? host.memoryMb * (1 << 20) : 1}
                format={(v) => fmtBytes(v)}
                detail={({ value, max, pct }) => (
                  <>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
                      <dt className="text-muted">Used</dt>
                      <dd className="text-right">
                        <LerpNum value={pct} format={(v) => `${v.toFixed(1)}%`} />
                      </dd>
                      <dt className="text-muted">Total</dt>
                      <dd className="text-right">
                        <LerpNum value={value} format={fmtBytes} /> / {fmtBytes(max)}
                      </dd>
                    </dl>
                    {usage && usage.agents.length > 0 && (
                      <div className="border-separator/40 mt-2 border-t pt-1.5">
                        <div className="text-muted/80 mb-1 text-[10px] tracking-wide uppercase">
                          Per agent (RSS)
                        </div>
                        <PerAgentList
                          items={usage.agents}
                          sortBy={(a) => a.memUsed}
                          format={(a) => <LerpNum value={a.memUsed} format={fmtBytes} />}
                        />
                      </div>
                    )}
                  </>
                )}
              />
              <LiveRing
                label="Disk"
                value={host ? host.diskUsedMb * (1 << 20) : 0}
                max={host ? host.diskTotalMb * (1 << 20) : 1}
                format={(v) => fmtBytes(v)}
                detail={({ value, max, pct }) => (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
                    <dt className="text-muted">Used</dt>
                    <dd className="text-right">
                      <LerpNum value={pct} format={(v) => `${v.toFixed(1)}%`} />
                    </dd>
                    <dt className="text-muted">Total</dt>
                    <dd className="text-right">
                      <LerpNum value={value} format={fmtBytes} /> / {fmtBytes(max)}
                    </dd>
                    <dt className="text-muted">Free</dt>
                    <dd className="text-right">
                      <LerpNum value={Math.max(0, max - value)} format={fmtBytes} />
                    </dd>
                  </dl>
                )}
              />
            </div>

            <div className="border-separator flex items-baseline justify-between gap-3 border-t pt-3 lg:ml-auto lg:block lg:border-0 lg:pt-0 lg:text-right">
              <div className="text-muted text-xs font-semibold tracking-wide uppercase">
                Last {rangeLabel}
              </div>
              <div className="text-sm">
                <span className="font-semibold tabular-nums">{fmtTokens(totalTokens)}</span> tokens
                · <span className="font-semibold tabular-nums">{fmtCost(totalCost)}</span>
              </div>
            </div>
          </div>

          {/* Charts. Each chart's title carries the current range (e.g.,
              "Tokens per agent · 7 days"); right-click anywhere on the
              dashboard to flip the range or any per-chart toggle. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                Tokens per agent · {rangeLabel}
              </div>
              <div className="h-28 w-full">
                {perAgent.length === 0 ? (
                  <p className="text-muted pt-8 text-center text-sm">No activity.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={perAgent} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        vertical={false}
                      />
                      <XAxis dataKey="name" tick={AXIS} stroke="var(--separator)" />
                      <YAxis
                        tickFormatter={fmtTokens}
                        width={44}
                        tick={AXIS}
                        stroke="var(--separator)"
                      />
                      <RechartsTooltip
                        cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                        contentStyle={TOOLTIP}
                        labelStyle={{ color: 'var(--muted)' }}
                        formatter={(v, n) =>
                          n === 'cost'
                            ? [fmtCost(Number(v) || 0), 'cost']
                            : [fmtTokens(Number(v) || 0), 'tokens']
                        }
                      />
                      <Bar dataKey="cost" hide />
                      <Bar dataKey="tokens" fill="#e0a55e" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div>
              <div className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                Total tokens &amp; cost · {rangeLabel}
              </div>
              <div className="h-28 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={overTime} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--separator)"
                      vertical={false}
                    />
                    <XAxis dataKey="label" interval={3} tick={AXIS} stroke="var(--separator)" />
                    <YAxis
                      yAxisId="t"
                      tickFormatter={fmtTokens}
                      width={44}
                      tick={AXIS}
                      stroke="var(--separator)"
                    />
                    {showCostLine && (
                      <YAxis
                        yAxisId="c"
                        orientation="right"
                        tickFormatter={(v) => fmtCost(Number(v) || 0)}
                        width={48}
                        tick={AXIS}
                        stroke="var(--separator)"
                      />
                    )}
                    <RechartsTooltip
                      cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                      contentStyle={TOOLTIP}
                      labelStyle={{ color: 'var(--muted)' }}
                      formatter={(v, n) =>
                        n === 'cost'
                          ? [fmtCost(Number(v) || 0), 'cost']
                          : [fmtTokens(Number(v) || 0), 'tokens']
                      }
                    />
                    <Bar yAxisId="t" dataKey="tokens" fill="#7aa2f7" radius={[2, 2, 0, 0]} />
                    {showCostLine && (
                      <Line
                        yAxisId="c"
                        type="monotone"
                        dataKey="cost"
                        stroke="#9ece6a"
                        strokeWidth={2}
                        dot={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Per-agent resource graphs over the requested window (one line per agent). */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ResourceChart
              title={`CPU per agent · ${rangeLabel}`}
              data={cpuData}
              series={series}
              format={(v) => `${Math.round(v)}%`}
              max={cpuMax}
              ticks={cpuTicks}
              smooth={smoothResource}
              timeTick={resourceTick}
            />
            <ResourceChart
              title={`Memory per agent · ${rangeLabel}`}
              data={memData}
              series={series}
              // Data is in MB. Tooltip stays precise (GB ≥1 GB, else MB); the
              // axis uses whole GB so labels stay short and don't wrap.
              format={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`)}
              tickFormat={(v) => `${Math.round(v / 1024)} GB`}
              max={memMax}
              ticks={memTicks}
              smooth={smoothResource}
              timeTick={resourceTick}
            />
          </div>
        </Card.Content>
      </Card>
    </motion.div>
  );
}

/** Compact tooltip for the per-agent resource charts. Hides series that are zero
 *  at the hovered time (idle/long-gone agents otherwise pad it with "0 MB" rows),
 *  dedupes by name, sorts by value, and caps the list so it never grows tall
 *  enough to clip out of the short chart. */
function ResourceTooltip({
  active,
  payload,
  label,
  format,
  timeTick = fmtClock,
}: {
  active?: boolean;
  payload?: { name?: string | number; value?: number; color?: string }[];
  label?: number;
  format: (v: number) => string;
  timeTick?: (t: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const seen = new Set<string>();
  const rows = payload
    .map((p) => ({
      name: String(p.name ?? ''),
      value: Math.round(Number(p.value) || 0),
      color: p.color,
    }))
    .filter((r) => r.value > 0 && !seen.has(r.name) && seen.add(r.name))
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return null;
  const MAX = 6;
  const shown = rows.slice(0, MAX);
  return (
    <div style={TOOLTIP} className="px-2.5 py-1.5">
      <div className="text-muted mb-0.5 text-xs">{timeTick(Number(label))}</div>
      {shown.map((r) => (
        <div key={r.name} className="flex items-center gap-2 text-xs leading-5">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: r.color }}
          />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          <span className="tabular-nums font-medium">{format(r.value)}</span>
        </div>
      ))}
      {rows.length > MAX && (
        <div className="text-muted mt-0.5 text-[11px]">+{rows.length - MAX} more</div>
      )}
    </div>
  );
}

/** A per-agent line chart over the chosen window (CPU% or memory MB). */
function ResourceChart({
  title,
  data,
  series,
  format,
  tickFormat,
  max,
  ticks,
  smooth = true,
  timeTick = fmtClock,
}: {
  title: string;
  data: Record<string, number>[];
  series: { id: string; name: string }[];
  /** Formats a value for the tooltip (adds the unit; may keep precision). */
  format: (v: number) => string;
  /** Formats a Y-axis tick; falls back to `format`. Used to keep axis labels
   *  short/whole (e.g. "23 GB") while the tooltip stays precise. */
  tickFormat?: (v: number) => string;
  /** Fixed Y-axis ceiling; auto-scales if undefined. */
  max?: number;
  /** Explicit tick stops on the Y axis (e.g. [0,100,200,300] for CPU%). When
   *  set, the axis renders exactly these — no recharts auto-stops. */
  ticks?: number[];
  /** When true the lines use recharts' "monotone" interpolation; when false
   *  they're straight segments — operator's pick from the context menu. */
  smooth?: boolean;
  /** X-axis tick formatter — varies by selected range so multi-day charts
   *  show dates instead of bare hours. */
  timeTick?: (t: number) => string;
}) {
  return (
    <div>
      <div className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">{title}</div>
      <div className="h-28 w-full">
        {data.length === 0 || series.length === 0 ? (
          <p className="text-muted pt-8 text-center text-sm">No data yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={timeTick}
                tick={AXIS}
                stroke="var(--separator)"
              />
              <YAxis
                width={52}
                tick={AXIS}
                stroke="var(--separator)"
                domain={max ? [0, max] : [0, 'auto']}
                ticks={ticks}
                tickFormatter={tickFormat ?? format}
                allowDataOverflow
              />
              <RechartsTooltip
                allowEscapeViewBox={{ x: false, y: true }}
                wrapperStyle={{ zIndex: 50 }}
                content={<ResourceTooltip format={format} timeTick={timeTick} />}
              />
              {series.map((s, i) => (
                <Line
                  key={s.id}
                  type={smooth ? 'monotone' : 'linear'}
                  dataKey={s.name}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
