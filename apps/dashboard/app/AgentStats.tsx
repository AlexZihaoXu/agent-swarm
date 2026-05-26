'use client';

import { useEffect, useState } from 'react';
import { getAgentStats, type AgentStats } from '@/lib/gateway';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
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

/** Compact one-line stats for a fleet card. */
export function AgentStatsInline({ agentId }: { agentId: string }) {
  const s = useAgentStats(agentId);
  if (!s || (!s.model && !s.tokens.total)) return null;
  return (
    <div className="text-muted mt-1 flex flex-wrap items-center gap-x-3 font-mono text-xs">
      {s.model && <span className="text-foreground">{s.model}</span>}
      {s.tokens.total > 0 && <span>{fmtTokens(s.tokens.total)} tok</span>}
      {s.cost != null && s.cost > 0 && <span>{fmtCost(s.cost)}</span>}
      {s.turns > 0 && <span>{s.turns} turns</span>}
    </div>
  );
}

/** Fuller readout for the agent view header. */
export function AgentStatsBar({ agentId }: { agentId: string }) {
  const s = useAgentStats(agentId);
  if (!s) return null;
  const t = s.tokens;
  return (
    <div className="text-muted ml-auto flex flex-wrap items-center gap-x-3 font-mono text-xs">
      {s.model && <span className="text-foreground font-semibold">{s.model}</span>}
      {s.status && <span className="capitalize">{s.status}</span>}
      {t.total > 0 && (
        <span title="input / output / cache-read">
          ↑{fmtTokens(t.input)} ↓{fmtTokens(t.output)} ⟳{fmtTokens(t.cacheRead)}
        </span>
      )}
      {t.total > 0 && <span className="text-foreground">{fmtTokens(t.total)} tok</span>}
      {s.cost != null && s.cost > 0 && <span>{fmtCost(s.cost)}</span>}
      {(s.linesAdded > 0 || s.linesRemoved > 0) && (
        <span>
          <span className="text-success">+{s.linesAdded}</span>{' '}
          <span className="text-danger">-{s.linesRemoved}</span>
        </span>
      )}
      {s.exceeds200k && <span className="text-warning">200k+</span>}
    </div>
  );
}
