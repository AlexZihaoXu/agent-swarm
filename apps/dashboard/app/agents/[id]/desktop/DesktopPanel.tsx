'use client';

import { Button } from '@heroui/react';
import { useState } from 'react';
import { LuLock, LuLockOpen } from 'react-icons/lu';

/**
 * Embedded noVNC desktop with an input lock. While locked (the default), a
 * transparent overlay sits over the iframe and swallows all pointer events, and
 * because clicks never reach the iframe it never takes focus — so keyboard input
 * doesn't route into noVNC either. Unlock to interact.
 */
export function DesktopPanel({ src, title }: { src: string; title: string }) {
  const [locked, setLocked] = useState(true);

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

      <Button
        size="sm"
        variant={locked ? 'secondary' : 'primary'}
        className="absolute top-3 right-3 z-20"
        onPress={() => setLocked((v) => !v)}
      >
        {locked ? <LuLock className="size-4" /> : <LuLockOpen className="size-4" />}
        {locked ? 'Input locked' : 'Input live'}
      </Button>
    </div>
  );
}
