'use client';

import { Toast } from '@heroui/react';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

// HeroUI v3 needs no provider of its own; next-themes just toggles the
// `class`/`data-theme` on <html> that the theme tokens key off of.
// Toast.Provider renders the toast region so `toast(...)` works from anywhere.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
      <Toast.Provider placement="bottom end" />
    </ThemeProvider>
  );
}
