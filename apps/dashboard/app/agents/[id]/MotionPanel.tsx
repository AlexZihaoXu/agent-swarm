'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Slides + fades a view panel into place. The slide direction matches the tab's
 * side (Terminal on the left enters from the left, Desktop on the right from the
 * right), so switching tabs reads as a left/right shift.
 */
export function MotionPanel({ from, children }: { from: 'left' | 'right'; children: ReactNode }) {
  const dx = from === 'left' ? -24 : 24;
  return (
    <motion.div
      className="h-full"
      initial={{ opacity: 0, x: dx }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
