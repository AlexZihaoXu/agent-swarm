'use client';

import { Button } from '@heroui/react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LuArrowUp, LuMessageSquare, LuPaperclip, LuTerminal, LuWrench, LuX } from 'react-icons/lu';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { getTranscript, terminalWsUrl, uploadToAgent, type ChatTurn } from '@/lib/gateway';
import { useAgentStats } from '@/app/AgentStats';

/**
 * Reveal `text` character-by-character over `duration` ms (0 = show instantly).
 * Animates once on mount; if the text later changes it snaps to full so polled
 * updates don't re-type an already-revealed message.
 */
function useTypewriter(text: string, duration: number): string {
  const [n, setN] = useState(duration > 0 ? 0 : text.length);
  const done = useRef(duration <= 0);
  useEffect(() => {
    if (done.current) {
      setN(text.length);
      return;
    }
    const len = text.length;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setN(Math.floor(p * len));
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        setN(len);
        done.current = true;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration]);
  return text.slice(0, n);
}

/** Assistant markdown, optionally typed out over 1.5s on first appearance. */
function AssistantText({ text, animate }: { text: string; animate: boolean }) {
  const shown = useTypewriter(text, animate ? 1500 : 0);
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {shown}
      </ReactMarkdown>
    </div>
  );
}

/** Three bouncing dots, shown where the agent's next reply will appear. */
function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted size-1.5 rounded-full"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: i * 0.15 }}
        />
      ))}
    </div>
  );
}

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
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attaching, setAttaching] = useState(false);
  const stats = useAgentStats(agentId);
  const working = stats?.status === 'busy';
  const awaiting = !!stats?.awaitingInput;
  // Track which turns are newly arrived (so only those type out, not history).
  const seenLen = useRef<number | null>(null);
  const animateIdx = useRef<Set<number>>(new Set());

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAttaching(true);
    try {
      const p = await uploadToAgent(agentId, file);
      setInput((prev) => (prev ? `${prev}\n${p}` : p));
    } catch {
      /* ignore */
    } finally {
      setAttaching(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const next = await getTranscript(agentId);
      // First load: treat everything as already-seen (no typing of history).
      // After that, mark each freshly appended turn to be typed out once.
      if (seenLen.current === null) seenLen.current = next.length;
      else if (next.length > seenLen.current) {
        for (let i = seenLen.current; i < next.length; i++) animateIdx.current.add(i);
        seenLen.current = next.length;
      }
      setTurns(next);
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
      // Re-baseline so reopening doesn't type out the whole backlog.
      seenLen.current = null;
      animateIdx.current.clear();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [open, agentId, refresh]);

  // Stick to the bottom as new turns arrive (and as the typing indicator shows).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, open, working]);

  // Type-to-focus: while the dock is open, starting to type anywhere (outside a
  // field) drops focus into the composer so the keystroke lands there.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
          className="bg-accent text-accent-foreground fixed right-4 bottom-4 z-50 flex size-12 cursor-grab items-center justify-center rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.45)] active:cursor-grabbing"
        >
          <LuMessageSquare className="size-5" />
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
            className="border-separator fixed top-16 right-4 z-50 flex h-[70vh] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-[color-mix(in_oklch,var(--overlay)_85%,transparent)] shadow-[0_16px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl"
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

            <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
              {turns.length === 0 && (
                <p className="text-muted text-sm">No messages yet. Say something below.</p>
              )}
              {turns.map((t, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                  className={t.role === 'user' ? 'flex justify-end' : ''}
                >
                  {/* User → bubble on the right; assistant → markdown on the left. */}
                  <div
                    className={
                      t.role === 'user'
                        ? 'bg-surface-secondary text-surface-secondary-foreground max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm font-medium'
                        : 'max-w-full space-y-2 font-medium'
                    }
                  >
                    {t.items.map((it, j) =>
                      it.kind === 'text' ? (
                        t.role === 'user' ? (
                          <p key={j} className="whitespace-pre-wrap">
                            {it.text}
                          </p>
                        ) : (
                          <AssistantText
                            key={j}
                            text={it.text ?? ''}
                            animate={animateIdx.current.has(i)}
                          />
                        )
                      ) : (
                        <div
                          key={j}
                          className="text-muted bg-surface-secondary/60 flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-xs"
                        >
                          <LuWrench className="size-3 shrink-0" />
                          <span className="shrink-0 font-semibold">{it.name}</span>
                          {it.detail && <span className="truncate opacity-80">{it.detail}</span>}
                        </div>
                      ),
                    )}
                  </div>
                </motion.div>
              ))}

              {/* The agent is composing — show a typing indicator right where
                  its reply will land. */}
              {working && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  <TypingDots />
                </motion.div>
              )}
            </div>

            {/* Interactive selectors (AskUserQuestion / plan / permission) are
                TUI-only and never reach the transcript, so they can't be shown
                or answered here — detect that one's open and route to the
                Terminal. */}
            <AnimatePresence>
              {awaiting && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="border-warning/40 bg-warning/10 mx-2 mb-1 rounded-xl border p-2.5"
                >
                  <p className="text-foreground text-sm font-medium">Waiting for your answer</p>
                  <p className="text-muted mt-0.5 text-xs">
                    {stats?.promptText
                      ? `“${stats.promptText}”`
                      : 'The agent is asking an interactive question.'}{' '}
                    It can only be answered in the Terminal.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2 gap-1.5"
                    render={(props) => (
                      <Link
                        {...(props as React.ComponentProps<typeof Link>)}
                        href={`/agents/${agentId}/terminal`}
                      />
                    )}
                  >
                    <LuTerminal className="size-3.5" />
                    Open Terminal
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="p-2">
              <div className="border-separator focus-within:border-accent bg-surface flex flex-col gap-2 rounded-2xl border p-2.5 transition-colors">
                <textarea
                  ref={inputRef}
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
                  className="placeholder:text-muted max-h-32 min-h-0 resize-none bg-transparent text-sm outline-none"
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Attach file"
                      onClick={() => fileRef.current?.click()}
                      className="text-muted hover:text-foreground hover:bg-surface-secondary flex size-8 items-center justify-center transition-colors"
                    >
                      <LuPaperclip className="size-4" />
                    </button>
                    <input ref={fileRef} type="file" hidden onChange={onPickFile} />
                    {attaching && <span className="text-muted text-xs">uploading…</span>}
                  </div>
                  <Button isIconOnly aria-label="Send" onPress={send} isDisabled={!input.trim()}>
                    <LuArrowUp className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
