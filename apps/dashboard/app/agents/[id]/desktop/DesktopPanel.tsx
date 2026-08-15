'use client';

import { LuMonitorOff } from 'react-icons/lu';
import { useEffect, useRef, useState } from 'react';
import { getAgent } from '@/lib/gateway';
import { useDesktopLock } from '../DesktopLock';

/**
 * Embedded noVNC desktop with an input lock. While locked (the default), a
 * transparent overlay sits over the iframe and swallows all pointer events, and
 * because clicks never reach the iframe it never takes focus — so keyboard input
 * doesn't route into noVNC either. The lock toggle lives in the header
 * (see DesktopLock); this panel just consumes the shared state.
 *
 * If the agent's `desktop` flag is off (operator disabled it via settings →
 * tigervncserver + novnc condition-fail at boot, no stream to render), show a
 * matching placeholder instead of an iframe that would hang on "connecting…".
 */
export function DesktopPanel({
  agentId,
  src,
  title,
}: {
  agentId: string;
  src: string;
  title: string;
}) {
  const { locked } = useDesktopLock();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [desktopOn, setDesktopOn] = useState<boolean | null>(null);

  // Unlocking is what hands the keyboard to the agent. Focus the iframe on that
  // transition so its own shortcuts — Ctrl-C/Ctrl-V included — work immediately,
  // rather than only after the user happens to click into the desktop. Without
  // this the keys stay with the dashboard and Ctrl-C copies this page.
  useEffect(() => {
    if (!locked) frameRef.current?.focus();
  }, [locked]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getAgent(agentId)
        .then((a) => alive && setDesktopOn(a.desktop !== false))
        .catch(() => {});
    void load();
    // Re-poll so toggling desktop from Settings flips this view without a refresh.
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agentId]);

  if (desktopOn === false) {
    return (
      <div className="bg-surface-secondary text-muted flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <LuMonitorOff className="size-10 opacity-50" aria-hidden />
        <div className="text-foreground text-sm font-semibold">Desktop is off</div>
        <p className="max-w-sm text-xs">
          The desktop service is disabled for this agent (saves ~2 GB RAM). Enable it from agent
          settings — tigervnc + novnc start on the next toggle.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <iframe ref={frameRef} title={title} src={src} className="h-full w-full border-0 bg-black" />

      {locked && (
        // Capture-phase blockers so nothing reaches the iframe while locked.
        <div
          className="absolute inset-0 z-10 cursor-not-allowed"
          onPointerDownCapture={(e) => e.preventDefault()}
          onMouseDownCapture={(e) => e.preventDefault()}
          onWheelCapture={(e) => e.preventDefault()}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
