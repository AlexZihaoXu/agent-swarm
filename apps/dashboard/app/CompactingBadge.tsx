'use client';

import { LuFoldVertical } from 'react-icons/lu';

/** A subtle "Compacting…" indicator with a progress bar, surfaced on the
 *  agent card whenever the gateway reports `agent.compacting === true` (a
 *  /compact was injected recently and the compaction is presumed still in
 *  flight). The progress value is a TTL-based estimate — Claude doesn't
 *  expose actual state, so the bar is a hint, not a precise readout.
 *
 *  Pulses gently while in flight so the operator can't miss that the agent
 *  isn't in a normal "busy" state — it's churning through compaction. */
export function CompactingBadge({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <span
      className="text-accent inline-flex min-w-0 flex-1 basis-32 items-center gap-1.5 text-[11px]"
      role="status"
      aria-live="polite"
      title="Claude is compacting its context window — the agent is paused while this runs"
    >
      <LuFoldVertical className="size-3 shrink-0 animate-pulse" aria-hidden />
      <span className="shrink-0 font-medium">Compacting</span>
      {/* Bar fills the space left in the row — shrinks when tight, capped so it
          never sprawls on a wide card. */}
      <span className="bg-accent/20 relative h-1 max-w-40 min-w-10 flex-1 overflow-hidden rounded-full">
        <span
          className="bg-accent absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </span>
    </span>
  );
}
