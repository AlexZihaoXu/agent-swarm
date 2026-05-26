'use client';

import { motion } from 'framer-motion';
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
export function useAgentStats(
  agentId: string,
  { intervalMs = 3000, enabled = true }: { intervalMs?: number; enabled?: boolean } = {},
): AgentStats | null {
  const [stats, setStats] = useState<AgentStats | null>(null);
  useEffect(() => {
    if (!enabled) {
      setStats(null);
      return;
    }
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
  }, [agentId, intervalMs, enabled]);
  return stats;
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
  return (
    <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
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
      {s.status && <ActivityBadge status={s.status} />}
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
