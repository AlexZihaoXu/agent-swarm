'use client';

import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { LuMonitor, LuMoon, LuSun } from 'react-icons/lu';

const OPTIONS = [
  { key: 'system', label: 'System', Icon: LuMonitor },
  { key: 'light', label: 'Light', Icon: LuSun },
  { key: 'dark', label: 'Dark', Icon: LuMoon },
] as const;

/**
 * Three-way theme switch (System / Light / Dark). A framer-motion `layoutId`
 * pill slides under the active option. Renders a neutral state until mounted to
 * avoid a hydration mismatch (the resolved theme is only known client-side).
 */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? 'system') : undefined;

  return (
    <div className="bg-surface-secondary border-separator inline-flex items-center gap-0.5 rounded-[calc(var(--radius)+0.125rem)] border p-0.5">
      {OPTIONS.map(({ key, label, Icon }) => {
        const active = current === key;
        return (
          <button
            key={key}
            type="button"
            aria-label={`${label} theme`}
            aria-pressed={active}
            onClick={() => setTheme(key)}
            className="relative flex h-7 w-9 items-center justify-center"
          >
            {active && (
              <motion.span
                layoutId="theme-pill"
                className="bg-surface shadow-surface absolute inset-0 rounded-[var(--radius)]"
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              />
            )}
            <Icon
              className={`relative size-4 transition-colors ${active ? 'text-foreground' : 'text-muted'}`}
            />
          </button>
        );
      })}
    </div>
  );
}
