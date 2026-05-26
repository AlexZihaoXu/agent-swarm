'use client';

import { Button } from '@heroui/react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { LuLock, LuLockOpen } from 'react-icons/lu';

// Shared so the toggle can live in the header (riding its entrance animation)
// while the lock state is consumed by the desktop panel (a separate route slot).
const Ctx = createContext<{ locked: boolean; setLocked: (v: boolean) => void } | null>(null);

export function DesktopLockProvider({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(true);
  return <Ctx.Provider value={{ locked, setLocked }}>{children}</Ctx.Provider>;
}

export function useDesktopLock() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDesktopLock must be used within DesktopLockProvider');
  return c;
}

/** Header toggle for the desktop input lock. */
export function DesktopLockButton() {
  const { locked, setLocked } = useDesktopLock();
  return (
    <Button
      size="sm"
      variant={locked ? 'secondary' : 'primary'}
      onPress={() => setLocked(!locked)}
      className="min-w-[8.5rem] justify-center gap-1.5 transition-colors duration-300"
    >
      {locked ? <LuLock className="size-4" /> : <LuLockOpen className="size-4" />}
      {locked ? 'Input locked' : 'Input live'}
    </Button>
  );
}
