'use client';

import { useEffect, useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuCoins,
  LuDollarSign,
  LuRefreshCcw,
  LuMessageSquare,
} from 'react-icons/lu';
import { getAgentStats, type AgentStats } from '@/lib/gateway';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return usd < 1 ? usd.toFixed(3) : usd.toFixed(2);
}

/** Polls one agent's live session stats (null until/unless reachable). */
export function useAgentStats(agentId: string, intervalMs = 3000): AgentStats | null {
  const [stats, setStats] = useState<AgentStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await getAgentStats(agentId);
        if (alive) setStats(s);
      } catch {
        /* agent stopped or supervisor unreachable */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agentId, intervalMs]);
  return stats;
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

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'busy' || status === 'running'
      ? 'bg-success'
      : status === 'idle'
        ? 'bg-muted'
        : 'bg-warning';
  return (
    <span className="flex items-center gap-1.5 capitalize">
      <span className={`size-1.5 rounded-full ${color}`} />
      {status}
    </span>
  );
}

/** Compact one-line stats for a fleet card. */
export function AgentStatsInline({ agentId }: { agentId: string }) {
  const s = useAgentStats(agentId);
  if (!s || (!s.model && !s.tokens.total)) return null;
  return (
    <div className="text-muted mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {s.model && <span className="text-foreground font-medium">{s.model}</span>}
      {s.tokens.total > 0 && (
        <Metric icon={<LuCoins className="size-3" />} title="total tokens" strong>
          {fmtTokens(s.tokens.total)}
        </Metric>
      )}
      {s.cost != null && s.cost > 0 && (
        <Metric icon={<LuDollarSign className="size-3" />} title="session cost (USD)">
          {fmtCost(s.cost)}
        </Metric>
      )}
      {s.turns > 0 && (
        <Metric icon={<LuMessageSquare className="size-3" />} title="turns">
          {s.turns}
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
      {s.status && <StatusDot status={s.status} />}
      {t.total > 0 && (
        <>
          <Metric icon={<LuArrowUp className="size-3" />} title="input tokens">
            {fmtTokens(t.input)}
          </Metric>
          <Metric icon={<LuArrowDown className="size-3" />} title="output tokens">
            {fmtTokens(t.output)}
          </Metric>
          <Metric icon={<LuRefreshCcw className="size-3" />} title="cache-read tokens">
            {fmtTokens(t.cacheRead)}
          </Metric>
          <Metric icon={<LuCoins className="size-3" />} title="total tokens" strong>
            {fmtTokens(t.total)}
          </Metric>
        </>
      )}
      {s.cost != null && s.cost > 0 && (
        <Metric icon={<LuDollarSign className="size-3" />} title="session cost (USD)">
          {fmtCost(s.cost)}
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
