'use client';

import { ProgressCircle, Tooltip } from '@heroui/react';
import { motion } from 'framer-motion';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  LuEllipsis,
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
function fmtContext(used: number, limit: number | null): string {
  const lim = limit ? ` / ${limit >= 1e6 ? `${limit / 1e6}M` : `${limit / 1e3}k`}` : '';
  return `${fmtTokens(used)}${lim}`;
}

/** Drop the "(1M context)" suffix — the progress circle conveys that. */
function cleanModel(model: string): string {
  return model.replace(/\s*\([^)]*context\)/i, '').trim();
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

/** Shared per-agent stats. The agent page mounts the stat bar, the chat dock and
 *  (when open) the chat panel — all needing the same live stats. Left un-shared
 *  they'd each open a 1Hz stats WebSocket to the agent, and every push drives a
 *  full transcript re-read in the container (2-3× the load per page open).
 *  Wrapping the agent page in <AgentStatsProvider> collapses that to one socket. */
const AgentStatsContext = createContext<{ stats: AgentStats | null } | undefined>(undefined);

export function AgentStatsProvider({
  agentId,
  children,
}: {
  agentId: string;
  children: ReactNode;
}) {
  const stats = useAgentStats(agentId);
  const value = useMemo(() => ({ stats }), [stats]);
  return <AgentStatsContext.Provider value={value}>{children}</AgentStatsContext.Provider>;
}

/** Read the shared stats when under an AgentStatsProvider; otherwise fall back to
 *  a private subscription (e.g. the dashboard chat, which has no provider). Always
 *  calls useAgentStats to honour the rules of hooks, but disables it when a
 *  provider already supplies the data so no extra socket opens. */
export function useAgentStatsShared(
  agentId: string,
  opts: { enabled?: boolean } = {},
): AgentStats | null {
  const ctx = useContext(AgentStatsContext);
  const own = useAgentStats(agentId, { enabled: ctx === undefined && (opts.enabled ?? true) });
  return ctx === undefined ? own : ctx.stats;
}

/**
 * Exponential-smoothing (lerp) toward `target`. Returns the current display
 * value and whether it's still animating (so the readout can highlight).
 */
function useLerp(target: number, factor = 0.2): [number, boolean] {
  const [display, setDisplay] = useState(target);
  const [active, setActive] = useState(false);
  const cur = useRef(target);
  useEffect(() => {
    if (cur.current === target) return;
    setActive(true);
    let raf = 0;
    const tick = () => {
      const next = cur.current + (target - cur.current) * factor;
      if (Math.abs(target - next) < 0.5) {
        cur.current = target;
        setDisplay(target);
        setActive(false);
        return;
      }
      cur.current = next;
      setDisplay(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, factor]);
  return [display, active];
}

/** Wraps an animated number, highlighting (accent) while it's changing. */
function Animated({ value, render }: { value: number; render: (v: number) => string }) {
  const [v, active] = useLerp(value);
  return (
    <span className={`transition-colors duration-700 ${active ? 'text-accent' : ''}`}>
      {render(v)}
    </span>
  );
}

function Tokens({ value }: { value: number }) {
  return <Animated value={value} render={(v) => fmtTokens(Math.round(v))} />;
}
function Cost({ value }: { value: number }) {
  return <Animated value={value} render={fmtCost} />;
}
function ContextUsage({ value, limit }: { value: number; limit: number | null }) {
  return <Animated value={value} render={(v) => fmtContext(Math.round(v), limit)} />;
}

/**
 * Context-window usage as a HeroUI progress circle + readout. The arc fills
 * toward the model's limit (when known) and shifts colour as it nears full;
 * with no known limit it falls back to a plain gauge readout.
 */
function ContextCircle({
  used,
  model,
  limit,
  compact,
}: {
  used: number;
  model: string | null;
  limit?: number | null;
  /** Compact: show just the used count (the ring conveys the limit) — saves
   *  horizontal space on the tight fleet-card row. */
  compact?: boolean;
}) {
  const [v] = useLerp(used);
  let lim = limit ?? contextLimit(model);
  // Sonnet/Opus 4.x run the 1M-token extended window, but Claude Code's
  // statusline reports the 200k base tier — which pegs the gauge at 100% once a
  // session passes 200k. Use the true 1M ceiling for those models.
  if (lim && lim < 1_000_000 && /(sonnet|opus)\s*4/i.test(model ?? '')) lim = 1_000_000;
  const title = `context window usage — ${fmtContext(used, lim)}`;
  if (used <= 0) {
    return (
      <Metric icon={<LuGauge className="size-3" />} title="context window usage" strong>
        --
      </Metric>
    );
  }
  if (!lim) {
    return (
      <Metric icon={<LuGauge className="size-3" />} title="context window usage" strong>
        <ContextUsage value={used} limit={null} />
      </Metric>
    );
  }
  const pct = Math.min(100, (v / lim) * 100);
  const color = pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent';
  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <span className="flex items-center gap-1.5 tabular-nums">
          <ProgressCircle
            aria-label={title}
            size="sm"
            color={color}
            value={v}
            maxValue={lim}
            className="scale-75"
          >
            <ProgressCircle.Track>
              <ProgressCircle.TrackCircle />
              <ProgressCircle.FillCircle />
            </ProgressCircle.Track>
          </ProgressCircle>
          <span className="text-foreground">
            {compact ? fmtTokens(Math.round(v)) : fmtContext(Math.round(v), lim)}
          </span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>{title}</Tooltip.Content>
    </Tooltip>
  );
}

/** "10080" minutes reads as nothing; "7d" reads as a week. */
function fmtWindow(minutes: number): string {
  if (!minutes || minutes <= 0) return '';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * ChatGPT (Codex) plan usage as a progress circle, mirroring ContextCircle.
 *
 * Shows the window that is furthest along, since that's the one that will
 * actually cut the agent off. The percentage is USED — the Codex CLI shows
 * REMAINING for the same numbers, so these two never agree and neither is wrong.
 *
 * The figures come from headers on the agent's last Codex call (there is no
 * usage endpoint), so they are as fresh as its last request and absent until it
 * makes one.
 */
function CodexLimitCircle({ limits }: { limits: NonNullable<AgentStats['codexLimits']> }) {
  const windows = [limits.primary, limits.secondary].filter(
    (w): w is NonNullable<typeof limits.primary> => !!w && w.windowMinutes > 0,
  );
  if (!windows.length) return null;
  const worst = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  const [v] = useLerp(worst.usedPercent);
  const color = worst.usedPercent >= 90 ? 'danger' : worst.usedPercent >= 75 ? 'warning' : 'accent';
  const resets = worst.resetsAt ? new Date(worst.resetsAt).toLocaleString() : 'unknown';
  const title =
    `Codex ${limits.plan ? `${limits.plan} ` : ''}usage — ${Math.round(worst.usedPercent)}% of the ` +
    `${fmtWindow(worst.windowMinutes)} limit used, resets ${resets}` +
    (windows.length > 1
      ? ` (showing the fuller of ${windows.map((w) => `${fmtWindow(w.windowMinutes)} ${Math.round(w.usedPercent)}%`).join(', ')})`
      : '');
  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <span className="flex items-center gap-1.5 tabular-nums">
          <ProgressCircle
            aria-label={title}
            size="sm"
            color={color}
            value={v}
            maxValue={100}
            className="scale-75"
          >
            <ProgressCircle.Track>
              <ProgressCircle.TrackCircle />
              <ProgressCircle.FillCircle />
            </ProgressCircle.Track>
          </ProgressCircle>
          <span className="text-foreground">
            {Math.round(v)}%
            {fmtWindow(worst.windowMinutes) && ` / ${fmtWindow(worst.windowMinutes)}`}
          </span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>{title}</Tooltip.Content>
    </Tooltip>
  );
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

/** A clock that re-renders every `ms` (for live durations). */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Timestamp (ms) the current status began. On the first sighting we anchor to
 *  the agent's last activity (so "idle for 2h" is right after a reload); on a
 *  later status change we stamp the moment we saw it flip. */
function useStatusSince(
  status: string | null,
  lastActivity: string | number | null,
): number | null {
  const [since, setSince] = useState<number | null>(null);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (!status) {
      prev.current = null;
      setSince(null);
      return;
    }
    if (prev.current === null) {
      const anchor = lastActivity != null ? new Date(lastActivity).getTime() : Number.NaN;
      setSince(Number.isFinite(anchor) ? anchor : Date.now());
    } else if (prev.current !== status) {
      setSince(Date.now());
    }
    prev.current = status;
  }, [status, lastActivity]);
  return since;
}

/** "12s", "5m", "3h 4m", "2d 1h". */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const DOT_BG: Record<'success' | 'warning' | 'danger' | 'default', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  default: 'bg-muted',
};

/**
 * Live activity line for a fleet card: a status dot + "idle for 5m" /
 * "working for 12s" (running agents), or just the container state otherwise.
 */
export function AgentActivity({
  containerStatus,
  sessionStatus,
  lastActivity,
}: {
  containerStatus: string;
  sessionStatus?: string | null;
  lastActivity?: string | number | null;
}) {
  const running = containerStatus === 'running';
  const since = useStatusSince(running ? (sessionStatus ?? null) : null, lastActivity ?? null);
  const now = useNow();
  const chip = agentChip(containerStatus, sessionStatus);
  const showDuration =
    running && since != null && (sessionStatus === 'idle' || sessionStatus === 'busy');
  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${chip.working ? 'text-success' : 'text-muted'}`}
    >
      <motion.span
        className={`inline-block size-1.5 rounded-full ${DOT_BG[chip.color]}`}
        animate={
          chip.working ? { opacity: [1, 0.25, 1], scale: [1, 1.3, 1] } : { opacity: 1, scale: 1 }
        }
        transition={
          chip.working ? { duration: 1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }
        }
      />
      {chip.label}
      {showDuration ? ` for ${fmtDuration(now - since)}` : ''}
    </span>
  );
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
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <span className={`flex items-center gap-1 tabular-nums ${strong ? 'text-foreground' : ''}`}>
          <span className="opacity-60">{icon}</span>
          {children}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>{title}</Tooltip.Content>
    </Tooltip>
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

/**
 * Compact one-line stats for a fleet card. Always renders the metric row —
 * context circle, tokens up, tokens down — falling back to "--" when there's no
 * data yet, so the line is consistent across every card.
 */
export function AgentStatsInline({ stats: s }: { stats: AgentStats | null }) {
  // "sent" = fresh input + cache writes (NOT cache reads — those are the same
  // context re-read each turn and would massively over-count when summed).
  const up = s ? s.tokens.input + s.tokens.cacheCreation : 0;
  const out = s?.tokens.output ?? 0;
  return (
    <div className="text-muted flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
      {s?.model && <span className="text-foreground font-medium">{cleanModel(s.model)}</span>}
      <ContextCircle
        used={s?.context ?? 0}
        model={s?.model ?? null}
        limit={s?.contextLimit}
        compact
      />
      <Metric icon={<LuArrowUp className="size-3" />} title="tokens sent (input + cache)">
        {up > 0 ? <Tokens value={up} /> : '--'}
      </Metric>
      <Metric icon={<LuArrowDown className="size-3" />} title="tokens received (output)">
        {out > 0 ? <Tokens value={out} /> : '--'}
      </Metric>
    </div>
  );
}

/** Fuller readout for the agent view header. */
export function AgentStatsBar({ agentId }: { agentId: string }) {
  const s = useAgentStatsShared(agentId);
  /** Available width vs. the bar's natural width. */
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Collapse when the full bar can't fit. The measurement is taken from a
  // hidden copy that ALWAYS renders the full content, never the collapsed
  // form — measuring the visible node instead would shrink it on collapse,
  // making it fit again, and the bar would oscillate forever.
  useEffect(() => {
    const wrap = wrapRef.current;
    const probe = measureRef.current;
    if (!wrap || !probe) return;
    const check = () => {
      const need = probe.scrollWidth;
      const have = wrap.clientWidth;
      // A few px of hysteresis so a borderline fit doesn't flicker.
      setCollapsed((prev) => (prev ? need > have - 8 : need > have));
    };
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    ro.observe(probe);
    check();
    return () => ro.disconnect();
  }, [s]);

  if (!s) return null;
  const t = s.tokens;
  // New tokens (exclude cache reads — repeated re-reads of the same context).
  const total = t.input + t.output + t.cacheCreation;

  const metrics = (
    <>
      {total > 0 && (
        <>
          <Metric icon={<LuArrowUp className="size-3" />} title="input tokens">
            <Tokens value={t.input} />
          </Metric>
          <Metric icon={<LuArrowDown className="size-3" />} title="output tokens">
            <Tokens value={t.output} />
          </Metric>
          <Metric
            icon={<LuRefreshCcw className="size-3" />}
            title="cache-read tokens (re-read each turn)"
          >
            <Tokens value={t.cacheRead} />
          </Metric>
          <Metric
            icon={<LuCoins className="size-3" />}
            title="new tokens (input + output + cache writes)"
            strong
          >
            <Tokens value={total} />
          </Metric>
        </>
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
      {s.privileges && !s.privileges.ok && (
        <span className="text-danger font-semibold" title={s.privileges.detail ?? undefined}>
          no sudo
        </span>
      )}
      {s.codexLimits && <CodexLimitCircle limits={s.codexLimits} />}
    </>
  );

  /** Kept visible even when collapsed — the identity and the one number you'd
   *  actually watch (how full the context is). */
  const essentials = (
    <>
      {s.model && <span className="text-foreground font-semibold">{s.model}</span>}
      {s.status && <ActivityBadge status={s.status} />}
      {s.context > 0 && <ContextCircle used={s.context} model={s.model} limit={s.contextLimit} />}
    </>
  );

  return (
    <div ref={wrapRef} className="relative ml-auto min-w-0 flex-1">
      {/* Hidden probe: the full bar at its natural width, used only for
          measurement. aria-hidden so it isn't announced twice. */}
      <div
        ref={measureRef}
        aria-hidden
        className="text-muted pointer-events-none invisible absolute top-0 left-0 flex items-center gap-x-3 text-xs whitespace-nowrap"
      >
        {essentials}
        {metrics}
      </div>

      <div className="text-muted flex items-center justify-end gap-x-3 text-xs whitespace-nowrap">
        {essentials}
        {collapsed ? (
          // Everything that didn't fit, one hover away.
          <Tooltip>
            <Tooltip.Trigger className="hover:text-foreground cursor-pointer px-1 leading-none">
              <LuEllipsis className="size-4" />
            </Tooltip.Trigger>
            <Tooltip.Content showArrow className="max-w-[320px]">
              <Tooltip.Arrow />
              <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1.5 text-xs">
                {metrics}
              </div>
            </Tooltip.Content>
          </Tooltip>
        ) : (
          metrics
        )}
      </div>
    </div>
  );
}
