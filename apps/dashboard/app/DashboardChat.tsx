'use client';

import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LuChevronLeft, LuMessageSquare, LuSettings, LuX } from 'react-icons/lu';
import type { Agent } from '@/lib/gateway';
import { AgentActivity, AgentStatsInline, agentChip, useAgentStats } from './AgentStats';
import { ChatPanel } from './ChatPanel';

const DOT: Record<'success' | 'warning' | 'danger' | 'default', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  default: 'bg-muted',
};

/** A row in the agent list with a LIVE status dot + label (its own stats sub). */
function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}) {
  const stats = useAgentStats(agent.id, { enabled: agent.status === 'running' });
  const chip = agentChip(agent.status, stats?.status);
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
        selected ? 'bg-accent/15' : 'hover:bg-surface'
      }`}
    >
      <motion.span
        className={`size-2 shrink-0 rounded-full ${DOT[chip.color]}`}
        animate={
          chip.working ? { opacity: [1, 0.3, 1], scale: [1, 1.3, 1] } : { opacity: 1, scale: 1 }
        }
        transition={
          chip.working ? { duration: 1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }
        }
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{agent.username || agent.id}</span>
          <span className="text-muted shrink-0 text-[11px]">
            {chip.working ? 'working' : chip.label}
          </span>
        </span>
        <span className="text-muted truncate font-mono text-[11px]">{agent.id}</span>
      </span>
    </button>
  );
}

/** Live header info for the selected agent: status + model/context/tokens. */
function HeaderStats({ agent }: { agent: Agent }) {
  const stats = useAgentStats(agent.id, { enabled: agent.status === 'running' });
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <AgentActivity
        containerStatus={agent.status}
        sessionStatus={stats?.status}
        lastActivity={stats?.lastActivity}
      />
      <AgentStatsInline stats={stats} />
    </div>
  );
}

/**
 * Dashboard quick chat: a centered button that opens a large panel sliding up
 * from the bottom (~80% × 67%), with a two-pane layout — running agents on the
 * left (live status), the selected agent's chat on the right.
 */
export function DashboardChat({ agents }: { agents: Agent[] }) {
  const running = agents.filter((a) => a.status === 'running');
  const ids = running.map((a) => a.id).join(',');
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Mobile is single-pane: show either the agent list or the chat. Desktop
  // shows both side-by-side regardless of this flag.
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    setSelectedId((cur) => (cur && list.includes(cur) ? cur : (list[0] ?? null)));
  }, [ids]);

  if (running.length === 0) return null;
  const selected = running.find((a) => a.id === selectedId) ?? running[0]!;

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            onClick={() => {
              setShowList(false);
              setOpen(true);
            }}
            // x:'-50%' keeps it centered while framer drives the y entrance
            // (a Tailwind -translate-x-1/2 would be overridden by framer's transform).
            initial={{ opacity: 0, y: 24, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 24, x: '-50%' }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ scale: 1.04, x: '-50%' }}
            whileTap={{ scale: 0.97, x: '-50%' }}
            className="border-separator bg-surface hover:bg-surface-secondary fixed bottom-6 left-1/2 z-40 flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium shadow-[0_8px_30px_rgba(0,0,0,0.25)]"
          >
            <LuMessageSquare className="size-4" />
            Chat with agents
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 sm:p-4"
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: 48, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 48, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="border-separator bg-surface flex h-[100dvh] w-full overflow-hidden rounded-none border shadow-[0_24px_80px_rgba(0,0,0,0.55)] sm:h-[83vh] sm:w-[80vw] sm:rounded-2xl"
            >
              {/* Mobile is single-pane: a horizontal track slides between the agent
                  list (pane 1) and the chat (pane 2). On sm+ the track is pinned
                  (sm:translate-x-0) so both panes sit side-by-side. */}
              <div
                className={`flex h-full w-full transition-transform duration-300 ease-out sm:translate-x-0 ${
                  showList ? 'translate-x-0' : '-translate-x-full'
                }`}
              >
                <aside className="border-separator bg-surface-secondary flex w-full shrink-0 flex-col border-r sm:w-56">
                  <div className="flex items-center justify-between px-3 py-3">
                    <span className="text-muted text-xs font-semibold tracking-wide uppercase">
                      Agents
                    </span>
                    <button
                      aria-label="Close chat"
                      className="text-muted hover:text-foreground sm:hidden"
                      onClick={() => setOpen(false)}
                    >
                      <LuX className="size-5" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
                    {running.map((a) => (
                      <AgentRow
                        key={a.id}
                        agent={a}
                        selected={a.id === selected.id}
                        onSelect={() => {
                          setSelectedId(a.id);
                          setShowList(false);
                        }}
                      />
                    ))}
                  </div>
                  <Link
                    href="/settings"
                    className="border-separator text-muted hover:text-foreground hover:bg-surface flex items-center gap-2 border-t px-3.5 py-2.5 text-sm transition-colors"
                  >
                    <LuSettings className="size-4" />
                    Settings
                  </Link>
                </aside>

                {/* Pane 2: the selected agent's chat (conversation area is recessed). */}
                <section className="flex w-full shrink-0 flex-col min-w-0 sm:w-auto sm:flex-1">
                  <header className="border-separator flex items-start gap-2 border-b px-4 py-3">
                    <button
                      aria-label="Back to agents"
                      className="text-muted hover:text-foreground mt-0.5 shrink-0 sm:hidden"
                      onClick={() => setShowList(true)}
                    >
                      <LuChevronLeft className="size-5" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">
                        {selected.username || selected.id}
                      </div>
                      <div className="text-muted truncate font-mono text-xs">{selected.id}</div>
                      <HeaderStats agent={selected} />
                    </div>
                    <button
                      aria-label="Close chat"
                      className="text-muted hover:text-foreground shrink-0"
                      onClick={() => setOpen(false)}
                    >
                      <LuX className="size-5" />
                    </button>
                  </header>
                  <ChatPanel key={selected.id} agentId={selected.id} active={open} />
                </section>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
