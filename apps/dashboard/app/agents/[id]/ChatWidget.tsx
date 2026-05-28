'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { LuMessageSquare, LuX } from 'react-icons/lu';
import { useAgentStats } from '@/app/AgentStats';
import { ChatPanel } from '@/app/ChatPanel';

/**
 * Floating chat dock for a single agent: a button that expands into a bottom-
 * right panel with the agent's conversation and composer (so you can chat
 * without switching to the Terminal tab).
 */
export function ChatWidget({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const stats = useAgentStats(agentId);
  const working = stats?.status === 'busy';

  return (
    <>
      {!open && (
        <motion.button
          aria-label="Open chat"
          onClick={() => setOpen(true)}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.95 }}
          className="bg-accent text-accent-foreground fixed right-4 bottom-4 z-50 flex size-12 cursor-pointer items-center justify-center rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
        >
          <LuMessageSquare className="size-5" />
        </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="border-separator bg-surface fixed right-4 bottom-4 z-50 flex h-[70vh] max-h-[calc(100vh-2rem)] w-[min(400px,calc(100vw-2rem))] origin-bottom-right flex-col overflow-hidden rounded-2xl border shadow-[0_16px_60px_rgba(0,0,0,0.55)]"
          >
            <header className="border-separator bg-surface-secondary flex items-center justify-between border-b px-3.5 py-3">
              <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                <LuMessageSquare className="text-muted size-4 shrink-0" />
                <span className="truncate">{agentId}</span>
                {working && (
                  <span className="text-success flex shrink-0 items-center gap-1 text-xs font-normal">
                    <motion.span
                      className="bg-success size-1.5 rounded-full"
                      animate={{ opacity: [1, 0.3, 1], scale: [1, 1.3, 1] }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    working
                  </span>
                )}
              </span>
              <button
                aria-label="Close chat"
                className="text-muted hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                <LuX className="size-4" />
              </button>
            </header>
            <ChatPanel agentId={agentId} active={open} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
