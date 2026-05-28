'use client';

import { Card, ProgressCircle } from '@heroui/react';
import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getMetrics, type Metrics, type RateWindow } from '@/lib/gateway';

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

/**
 * Always-on usage overview: 5h/7d rate-limit rings, per-agent 24h tokens, and
 * total tokens + money spent over the last 24h. Polls every 30s.
 */
export function DashboardMetrics() {
  const [m, setM] = useState<Metrics | null>(null);

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

  if (!m) return null;
  const perAgent = m.agents
    .filter((a) => a.tokens > 0)
    .map((a) => ({ name: a.name, tokens: a.tokens, cost: a.cost }))
    .sort((a, b) => b.tokens - a.tokens);
  const overTime = m.buckets.map((b) => ({ label: fmtHour(b.t), tokens: b.tokens, cost: b.cost }));
  const totalTokens = m.agents.reduce((s, a) => s + a.tokens, 0);
  const totalCost = m.agents.reduce((s, a) => s + a.cost, 0);

  return (
    <Card className="mb-6">
      <Card.Content className="space-y-5">
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
          <div className="ml-auto text-right">
            <div className="text-muted text-xs font-semibold tracking-wide uppercase">Last 24h</div>
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
              Tokens per agent · 24h
            </div>
            <div className="h-56 w-full">
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
              Total tokens &amp; cost · 24h
            </div>
            <div className="h-56 w-full">
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
      </Card.Content>
    </Card>
  );
}
