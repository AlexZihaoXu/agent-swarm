'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { LuMessageSquare, LuX } from 'react-icons/lu';
import type { Agent } from '@/lib/gateway';
import { ChatPanel } from './ChatPanel';

/**
 * Dashboard quick chat: a centered button that opens a large panel sliding up
 * from the bottom (~80% × 67%), with a Discord-style two-pane layout — running
 * agents on the left, the selected agent's chat on the right.
 */
export function DashboardChat({ agents }: { agents: Agent[] }) {
  const running = agents.filter((a) => a.status === 'running');
  const ids = running.map((a) => a.id).join(',');
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep the selection valid as the running set changes.
  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    setSelectedId((cur) => (cur && list.includes(cur) ? cur : (list[0] ?? null)));
  }, [ids]);

  if (running.length === 0) return null;
  const selected = running.find((a) => a.id === selectedId) ?? running[0]!;

  return (
    <>
      {!open && (
        <motion.button
          onClick={() => setOpen(true)}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          className="border-separator bg-surface hover:bg-surface-secondary fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium shadow-[0_8px_30px_rgba(0,0,0,0.25)]"
        >
          <LuMessageSquare className="size-4" />
          Chat with agents
        </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: 48, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 48, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="border-separator bg-surface flex h-[67vh] w-[80vw] overflow-hidden rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
            >
              {/* Left: agent list */}
              <aside className="border-separator bg-surface-secondary flex w-56 shrink-0 flex-col border-r">
                <div className="text-muted px-3 py-3 text-xs font-semibold tracking-wide uppercase">
                  Agents
                </div>
                <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
                  {running.map((a) => {
                    const on = a.id === selected.id;
                    return (
                      <button
                        key={a.id}
                        onClick={() => setSelectedId(a.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                          on ? 'bg-accent/15' : 'hover:bg-surface'
                        }`}
                      >
                        <span className="bg-success size-2 shrink-0 rounded-full" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">{a.username || a.id}</span>
                          <span className="text-muted truncate font-mono text-[11px]">{a.id}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </aside>

              {/* Right: the selected agent's chat */}
              <section className="flex min-w-0 flex-1 flex-col">
                <header className="border-separator flex items-center justify-between border-b px-4 py-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">
                      {selected.username || selected.id}
                    </span>
                    <span className="text-muted truncate font-mono text-xs">{selected.id}</span>
                  </span>
                  <button
                    aria-label="Close chat"
                    className="text-muted hover:text-foreground"
                    onClick={() => setOpen(false)}
                  >
                    <LuX className="size-5" />
                  </button>
                </header>
                <ChatPanel key={selected.id} agentId={selected.id} active={open} />
              </section>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
