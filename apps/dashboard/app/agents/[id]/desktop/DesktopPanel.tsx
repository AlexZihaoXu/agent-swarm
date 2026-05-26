'use client';

import { useDesktopLock } from '../DesktopLock';

/**
 * Embedded noVNC desktop with an input lock. While locked (the default), a
 * transparent overlay sits over the iframe and swallows all pointer events, and
 * because clicks never reach the iframe it never takes focus — so keyboard input
 * doesn't route into noVNC either. The lock toggle lives in the header
 * (see DesktopLock); this panel just consumes the shared state.
 */
export function DesktopPanel({ src, title }: { src: string; title: string }) {
  const { locked } = useDesktopLock();

  return (
    <div className="relative h-full w-full">
      <iframe title={title} src={src} className="h-full w-full border-0 bg-black" />

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
