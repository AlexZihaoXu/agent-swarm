'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuCoins,
  LuDollarSign,
  LuGauge,
  LuRefreshCcw,
} from 'react-icons/lu';
import { getAgentStats, statsStreamUrl, type AgentStats } from '@/lib/gateway';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return usd < 1 ? usd.toFixed(3) : usd.toFixed(2);
}

/** Pull the context-window limit out of a model name like "Opus 4.7 (1M context)". */
function contextLimit(model: string | null): number | null {
  const m = model?.match(/\((\d+)\s*([km])?\s*context\)/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] || '').toLowerCase();
  return unit === 'm' ? n * 1e6 : unit === 'k' ? n * 1e3 : n;
}

/** "41.0k / 1M" when the model's limit is known, else "41.0k". */
function fmtContext(used: number, model: string | null): string {
  const limit = contextLimit(model);
  const lim = limit ? ` / ${limit >= 1e6 ? `${limit / 1e6}M` : `${limit / 1e3}k`}` : '';
  return `${fmtTokens(used)}${lim}`;
}

/**
 * One agent's live session stats: a single snapshot request for immediate data,
 * then a WebSocket stream (pushes ~1/s) for real-time updates. Reconnects if the
 * socket drops. Null until/unless reachable.
 */
export function useAgentStats(
  agentId: string,
  { enabled = true }: { enabled?: boolean } = {},
): AgentStats | null {
  const [stats, setStats] = useState<AgentStats | null>(null);
  useEffect(() => {
    if (!enabled) {
      setStats(null);
      return;
    }
    let alive = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;

    // Snapshot for instant data, then subscribe to the stream.
    getAgentStats(agentId)
      .then((s) => alive && setStats(s))
      .catch(() => {});

    const connect = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(statsStreamUrl(agentId));
      } catch {
        return;
      }
      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          setStats(JSON.parse(e.data as string));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (alive) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };
    connect();

    return () => {
      alive = false;
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [agentId, enabled]);
  return stats;
}

/** Exponential-smoothing (lerp) toward `target` for animated number readouts. */
function useLerp(target: number, factor = 0.2): number {
  const [display, setDisplay] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = cur.current + (target - cur.current) * factor;
      if (Math.abs(target - next) < 0.5) {
        cur.current = target;
        setDisplay(target);
        return;
      }
      cur.current = next;
      setDisplay(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, factor]);
  return display;
}

function Tokens({ value }: { value: number }) {
  return <>{fmtTokens(Math.round(useLerp(value)))}</>;
}
function Cost({ value }: { value: number }) {
  return <>{fmtCost(useLerp(value))}</>;
}
function ContextUsage({ value, model }: { value: number; model: string | null }) {
  return <>{fmtContext(Math.round(useLerp(value)), model)}</>;
}

/** Maps the container + claude-session status into a single chip. */
export function agentChip(
  containerStatus: string,
  sessionStatus?: string | null,
): {
  label: string;
  color: 'success' | 'warning' | 'danger' | 'default';
  working: boolean;
} {
  if (containerStatus !== 'running') {
    const danger = containerStatus === 'exited' || containerStatus === 'dead';
    return { label: containerStatus, color: danger ? 'danger' : 'warning', working: false };
  }
  if (sessionStatus === 'busy') return { label: 'working', color: 'success', working: true };
  if (sessionStatus === 'idle') return { label: 'idle', color: 'warning', working: false };
  return { label: 'running', color: 'success', working: false };
}

function Metric({
  icon,
  title,
  children,
  strong,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <span
      title={title}
      className={`flex items-center gap-1 tabular-nums ${strong ? 'text-foreground' : ''}`}
    >
      <span className="opacity-60">{icon}</span>
      {children}
    </span>
  );
}

/**
 * Claude session activity. `busy` (the session is generating) shows a pulsing
 * green "working"; `idle` is a muted "idle"; anything else shows raw.
 */
function ActivityBadge({ status }: { status: string }) {
  const working = status === 'busy';
  const label = working ? 'working' : status === 'idle' ? 'idle' : status;
  return (
    <span className={`flex items-center gap-1.5 ${working ? 'text-success' : ''}`}>
      <motion.span
        className={`size-1.5 rounded-full ${working ? 'bg-success' : 'bg-muted'}`}
        animate={working ? { opacity: [1, 0.25, 1], scale: [1, 1.3, 1] } : { opacity: 1, scale: 1 }}
        transition={
          working ? { duration: 1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }
        }
      />
      {label}
    </span>
  );
}

/** Compact one-line stats for a fleet card (presentational — caller supplies stats). */
export function AgentStatsInline({ stats: s }: { stats: AgentStats | null }) {
  if (!s || (!s.model && !s.tokens.total)) return null;
  const up = s.tokens.input + s.tokens.cacheCreation + s.tokens.cacheRead;
  return (
    <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {s.model && <span className="text-foreground font-medium">{s.model}</span>}
      {s.context > 0 && (
        <Metric icon={<LuGauge className="size-3" />} title="context window usage" strong>
          <ContextUsage value={s.context} model={s.model} />
        </Metric>
      )}
      {up > 0 && (
        <Metric icon={<LuArrowUp className="size-3" />} title="tokens sent (input + cache)">
          <Tokens value={up} />
        </Metric>
      )}
      {s.tokens.output > 0 && (
        <Metric icon={<LuArrowDown className="size-3" />} title="tokens received (output)">
          <Tokens value={s.tokens.output} />
        </Metric>
      )}
      {s.cost != null && s.cost > 0 && (
        <Metric icon={<LuDollarSign className="size-3" />} title="money spent (USD)">
          <Cost value={s.cost} />
        </Metric>
      )}
    </div>
  );
}

/** Fuller readout for the agent view header. */
export function AgentStatsBar({ agentId }: { agentId: string }) {
  const s = useAgentStats(agentId);
  if (!s) return null;
  const t = s.tokens;
  return (
    <div className="text-muted ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {s.model && <span className="text-foreground font-semibold">{s.model}</span>}
      {s.status && <ActivityBadge status={s.status} />}
      {t.total > 0 && (
        <>
          <Metric icon={<LuArrowUp className="size-3" />} title="input tokens">
            <Tokens value={t.input} />
          </Metric>
          <Metric icon={<LuArrowDown className="size-3" />} title="output tokens">
            <Tokens value={t.output} />
          </Metric>
          <Metric icon={<LuRefreshCcw className="size-3" />} title="cache-read tokens">
            <Tokens value={t.cacheRead} />
          </Metric>
          <Metric icon={<LuCoins className="size-3" />} title="total tokens" strong>
            <Tokens value={t.total} />
          </Metric>
        </>
      )}
      {s.context > 0 && (
        <Metric icon={<LuGauge className="size-3" />} title="context window usage" strong>
          <ContextUsage value={s.context} model={s.model} />
        </Metric>
      )}
      {s.cost != null && s.cost > 0 && (
        <Metric icon={<LuDollarSign className="size-3" />} title="session cost (USD)">
          <Cost value={s.cost} />
        </Metric>
      )}
      {(s.linesAdded > 0 || s.linesRemoved > 0) && (
        <span className="tabular-nums" title="lines added / removed">
          <span className="text-success">+{s.linesAdded}</span>{' '}
          <span className="text-danger">-{s.linesRemoved}</span>
        </span>
      )}
      {s.exceeds200k && <span className="text-warning">200k+</span>}
    </div>
  );
}
