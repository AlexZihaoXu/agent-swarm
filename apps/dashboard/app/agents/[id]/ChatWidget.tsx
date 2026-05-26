'use client';

import { Button } from '@heroui/react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LuMessageSquare, LuSend, LuX } from 'react-icons/lu';
import { getTranscript, terminalWsUrl, type ChatTurn } from '@/lib/gateway';
import { useAgentStats } from '@/app/AgentStats';

/**
 * Floating chat dock: a small button that expands into a panel (top-right) where
 * you can read the agent's conversation and send messages to the `claude`
 * session — without switching to the Terminal tab. Reading comes from the
 * transcript (polled); sending writes to the session's pty over its WebSocket.
 */
export function ChatWidget({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const draggedRef = useRef(false);
  const working = useAgentStats(agentId)?.status === 'busy';

  const refresh = useCallback(async () => {
    try {
      setTurns(await getTranscript(agentId));
    } catch {
      /* unreachable */
    }
  }, [agentId]);

  // While open: poll the transcript and keep a send socket to the claude session.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const poll = setInterval(() => void refresh(), 2000);
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(terminalWsUrl(agentId));
      wsRef.current = ws;
    } catch {
      /* ignore */
    }
    return () => {
      clearInterval(poll);
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [open, agentId, refresh]);

  // Stick to the bottom as new turns arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, open]);

  const send = () => {
    const text = input.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'data', data: text }));
    ws.send(JSON.stringify({ type: 'data', data: '\r' }));
    // Optimistic echo until the transcript catches up.
    setTurns((prev) => [
      ...prev,
      { role: 'user', ts: Date.now(), items: [{ kind: 'text', text }] },
    ]);
    setInput('');
  };

  return (
    <>
      {!open && (
        <motion.button
          aria-label="Open chat"
          drag
          dragMomentum={false}
          onDragStart={() => (draggedRef.current = true)}
          onDragEnd={() => setTimeout(() => (draggedRef.current = false), 0)}
          onClick={() => {
            if (!draggedRef.current) setOpen(true);
          }}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.95 }}
          className="bg-accent text-accent-foreground shadow-overlay fixed right-4 bottom-4 z-50 flex size-12 cursor-grab items-center justify-center rounded-full active:cursor-grabbing"
        >
          <LuMessageSquare className="size-5" />
          {working && (
            <motion.span
              className="bg-success absolute -top-0.5 -right-0.5 size-3 rounded-full ring-2 ring-[var(--background)]"
              animate={{ opacity: [1, 0.3, 1], scale: [1, 1.2, 1] }}
              transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            drag
            dragControls={dragControls}
            dragListener={false}
            dragMomentum={false}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="border-separator shadow-overlay fixed top-16 right-4 z-50 flex h-[70vh] w-[min(380px,calc(100vw-2rem))] flex-col border bg-[color-mix(in_oklch,var(--overlay)_80%,transparent)] backdrop-blur-md"
          >
            <header
              onPointerDown={(e) => dragControls.start(e)}
              className="border-separator flex cursor-grab items-center justify-between border-b px-3 py-2 select-none active:cursor-grabbing"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                Chat · {agentId}
                {working && (
                  <span className="text-success flex items-center gap-1 text-xs font-normal">
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

            <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
              {turns.length === 0 && (
                <p className="text-muted text-sm">No messages yet. Say something below.</p>
              )}
              {turns.map((t, i) => (
                <div key={i} className={t.role === 'user' ? 'text-right' : ''}>
                  <span className="text-muted text-[10px] tracking-wide uppercase">{t.role}</span>
                  {t.items.map((it, j) =>
                    it.kind === 'text' ? (
                      <div
                        key={j}
                        className={`mt-0.5 inline-block max-w-full rounded px-2 py-1 text-sm whitespace-pre-wrap ${
                          t.role === 'user'
                            ? 'bg-accent-soft text-accent-soft-foreground text-left'
                            : 'bg-surface-secondary'
                        }`}
                      >
                        {it.text}
                      </div>
                    ) : (
                      <div key={j} className="text-muted mt-0.5 font-mono text-xs">
                        ⚙ {it.name}
                      </div>
                    ),
                  )}
                </div>
              ))}
            </div>

            <div className="border-separator flex items-end gap-2 border-t p-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder="Message the agent…"
                className="bg-field text-field-foreground border-field-border min-h-0 flex-1 resize-none border px-2 py-1 text-sm outline-none"
              />
              <Button isIconOnly aria-label="Send" onPress={send} isDisabled={!input.trim()}>
                <LuSend className="size-4" />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
