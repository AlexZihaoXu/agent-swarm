'use client';

import { Button, Modal } from '@heroui/react';
import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getMetrics, type Metrics } from '@/lib/gateway';

// Distinct, theme-friendly series colors, cycled per agent.
const COLORS = [
  '#e0a55e',
  '#7aa2f7',
  '#9ece6a',
  '#bb9af7',
  '#f7768e',
  '#7dcfff',
  '#e0af68',
  '#c0caf5',
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtHour(t: number): string {
  return `${String(new Date(t).getHours()).padStart(2, '0')}:00`;
}

/** Global token metrics: tokens burnt (24h) + per-agent tokens/hour as a
 * stacked bar chart (one stacked segment per agent, per hourly bar). */
export function MetricsModal({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setM(null);
    setErr(null);
    getMetrics()
      .then(setM)
      .catch((e) => setErr(String((e as Error)?.message ?? e)));
  }, [isOpen]);

  const data = m
    ? m.buckets.map((b) => {
        const row: Record<string, number | string> = { label: fmtHour(b.t) };
        for (const a of m.agents) row[a.id] = b.tokens[a.id] || 0;
        return row;
      })
    : [];
  // Only chart agents that actually burnt tokens in the window.
  const active = m ? m.agents.filter((a) => m.buckets.some((b) => (b.tokens[a.id] || 0) > 0)) : [];

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[760px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Metrics</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {err && <p className="text-danger text-sm">{err}</p>}
              {!m && !err && <p className="text-muted text-sm">Loading…</p>}
              {m && (
                <>
                  <div className="mb-4">
                    <div className="text-muted text-xs font-semibold tracking-wide uppercase">
                      Tokens burnt · last 24h
                    </div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {fmtTokens(m.totalTokens)}
                    </div>
                  </div>
                  {active.length === 0 ? (
                    <p className="text-muted text-sm">No token activity in the last 24 hours.</p>
                  ) : (
                    <div className="h-72 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--separator)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="label"
                            interval={2}
                            tick={{ fontSize: 11, fill: 'var(--muted)' }}
                            stroke="var(--separator)"
                          />
                          <YAxis
                            width={44}
                            tickFormatter={fmtTokens}
                            tick={{ fontSize: 11, fill: 'var(--muted)' }}
                            stroke="var(--separator)"
                          />
                          <Tooltip
                            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                            contentStyle={{
                              background: 'var(--surface)',
                              border: '1px solid var(--separator)',
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                            labelStyle={{ color: 'var(--muted)' }}
                            formatter={(value) =>
                              fmtTokens(typeof value === 'number' ? value : Number(value) || 0)
                            }
                          />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          {active.map((a, i) => (
                            <Bar
                              key={a.id}
                              dataKey={a.id}
                              name={a.name}
                              stackId="t"
                              fill={COLORS[i % COLORS.length]}
                              radius={i === active.length - 1 ? [2, 2, 0, 0] : 0}
                            />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
