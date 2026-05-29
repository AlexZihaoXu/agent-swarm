'use client';

import { Card, ProgressCircle } from '@heroui/react';
import { animate } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
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

/** Distinct line colors for per-agent resource graphs (cycled by index). */
const LINE_COLORS = ['#e0a55e', '#7aa2f7', '#9ece6a', '#bb9af7', '#f7768e', '#7dcfff', '#e0af68'];

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}
function fmtClock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  return `${String(new Date(t).getHours()).padStart(2, '0')}:00`;
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

/** Live resource ring (CPU / memory): a progress circle filled to value/max with
 *  a lerped %, plus a label + sub-line. Colour tracks utilization. */
function LiveRing({
  label,
  value,
  max,
  format,
}: {
  label: string;
  value: number;
  max: number;
  /** Sub-line text from the lerped value (so it eases, not jumps). */
  format: (shown: number) => string;
}) {
  const shown = useLerp(value);
  const pct = max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0;
  const color = pct >= 85 ? 'danger' : pct >= 60 ? 'warning' : 'success';
  return (
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

  // Host hardware = the fixed ceiling for the resource graphs (max exposed).
  useEffect(() => {
    getHostInfo()
      .then(setHost)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getMetrics()
        .then((d) => alive && setM(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Live resource usage refreshes fast (cheap snapshot) for the headline numbers.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getUsage()
        .then((u) => alive && setUsage(u))
        .catch(() => {});
    void load();
    const t = setInterval(load, 500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!m) return null;
  const perAgent = m.agents
    .filter((a) => a.tokens > 0)
    .map((a) => ({ name: a.name, tokens: a.tokens, cost: a.cost }))
    .sort((a, b) => b.tokens - a.tokens);
  const overTime = m.buckets.map((b) => ({ label: fmtHour(b.t), tokens: b.tokens, cost: b.cost }));
  const totalTokens = m.agents.reduce((s, a) => s + a.tokens, 0);
  const totalCost = m.agents.reduce((s, a) => s + a.cost, 0);

  // Per-agent 12h resource series → recharts rows keyed by agent name.
  const series = m.usage.series;
  const cpuData = m.usage.points.map((p) => {
    const row: Record<string, number> = { t: p.t };
    for (const s of series) row[s.name] = p.cpu[s.id] ?? 0;
    return row;
  });
  const memData = m.usage.points.map((p) => {
    const row: Record<string, number> = { t: p.t };
    for (const s of series) row[s.name] = Math.round((p.mem[s.id] ?? 0) / (1 << 20)); // MB
    return row;
  });

  return (
    <Card className="mb-6">
      <Card.Content className="space-y-3">
        {/* Rate-limit rings + 24h totals */}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
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
            <span className="text-muted text-sm">No usage data yet.</span>
          )}

          {/* Divider, then live CPU + memory rings across running agents (~2/s). */}
          <div className="bg-separator h-10 w-px" />
          <LiveRing
            label="CPU"
            value={usage?.cpuPct ?? 0}
            max={host ? host.cpus * 100 : 100}
            format={() => (host ? `${host.cpus} cores` : '')}
          />
          <LiveRing
            label="Memory"
            value={usage?.memUsed ?? 0}
            max={host ? host.memoryMb * (1 << 20) : 1}
            format={(v) => fmtBytes(v)}
          />

          <div className="ml-auto text-right">
            <div className="text-muted text-xs font-semibold tracking-wide uppercase">Last 12h</div>
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{fmtTokens(totalTokens)}</span> tokens ·{' '}
              <span className="font-semibold tabular-nums">{fmtCost(totalCost)}</span>
            </div>
          </div>
        </div>

        {/* Charts */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <div className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              Tokens per agent · 12h
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
                    <Tooltip
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
              Total tokens &amp; cost · 12h
            </div>
            <div className="h-28 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={overTime} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
                  <XAxis dataKey="label" interval={3} tick={AXIS} stroke="var(--separator)" />
                  <YAxis
                    yAxisId="t"
                    tickFormatter={fmtTokens}
                    width={44}
                    tick={AXIS}
                    stroke="var(--separator)"
                  />
                  <YAxis
                    yAxisId="c"
                    orientation="right"
                    tickFormatter={(v) => fmtCost(Number(v) || 0)}
                    width={48}
                    tick={AXIS}
                    stroke="var(--separator)"
                  />
                  <Tooltip
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
                  <Line
                    yAxisId="c"
                    type="monotone"
                    dataKey="cost"
                    stroke="#9ece6a"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Per-agent resource graphs over the last 12h (one line per agent). */}
        <div className="grid gap-6 lg:grid-cols-2">
          <ResourceChart
            title="CPU per agent · 12h"
            data={cpuData}
            series={series}
            unit="%"
            max={host ? host.cpus * 100 : undefined}
          />
          <ResourceChart
            title="Memory per agent · 12h"
            data={memData}
            series={series}
            unit=" MB"
            max={host ? host.memoryMb : undefined}
          />
        </div>
      </Card.Content>
    </Card>
  );
}

/** A per-agent line chart over the 12h window (CPU% or memory MB). */
function ResourceChart({
  title,
  data,
  series,
  unit,
  max,
}: {
  title: string;
  data: Record<string, number>[];
  series: { id: string; name: string }[];
  unit: string;
  /** Fixed Y-axis ceiling (max resources exposed); auto-scales if undefined. */
  max?: number;
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
                tickFormatter={fmtClock}
                tick={AXIS}
                stroke="var(--separator)"
              />
              <YAxis
                width={44}
                tick={AXIS}
                stroke="var(--separator)"
                domain={max ? [0, max] : [0, 'auto']}
                allowDataOverflow
              />
              <Tooltip
                contentStyle={TOOLTIP}
                labelStyle={{ color: 'var(--muted)' }}
                labelFormatter={(t) => fmtClock(Number(t))}
                formatter={(v, n) => [`${Math.round(Number(v) || 0)}${unit}`, n]}
              />
              {series.map((s, i) => (
                <Line
                  key={s.id}
                  type="monotone"
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
