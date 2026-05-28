'use client';

import { Button } from '@heroui/react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  LuArrowUp,
  LuCheck,
  LuMessageSquare,
  LuPaperclip,
  LuTerminal,
  LuTriangleAlert,
  LuWrench,
  LuX,
} from 'react-icons/lu';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  getPromptHtml,
  getTranscript,
  terminalWsUrl,
  uploadToAgent,
  type ChatTurn,
} from '@/lib/gateway';
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

/** Assistant markdown, typed out on first appearance at ~60 char/s, capped at
 * 1.5s for long messages (so short replies reveal quickly, long ones don't drag). */
function AssistantText({ text, animate }: { text: string; animate: boolean }) {
  const duration = animate ? Math.min(1500, Math.round((text.length / 60) * 1000)) : 0;
  const shown = useTypewriter(text, duration);
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {shown}
      </ReactMarkdown>
    </div>
  );
}

/** A tool call. MCP tools follow `mcp__<server>__<tool>` — render the server as
 * a small badge and the bare tool name, instead of the raw underscored id. */
function ToolItem({ name, detail }: { name: string; detail?: string }) {
  let server: string | null = null;
  let tool = name;
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const i = rest.indexOf('__');
    if (i >= 0) {
      server = rest.slice(0, i);
      tool = rest.slice(i + 2);
    }
  }
  return (
    <div className="text-muted bg-surface-secondary/60 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs">
      <LuWrench className="size-3 shrink-0" />
      {server && (
        <span className="bg-surface-tertiary text-muted shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
          {server}
        </span>
      )}
      <span className="shrink-0 font-mono font-semibold">{tool}</span>
      {detail && <span className="truncate font-mono opacity-80">{detail}</span>}
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
export function ChatWidget({
  agentId,
  agents,
  onSelectAgent,
}: {
  agentId: string;
  /** When provided, the dock header shows a picker to switch agents (dashboard). */
  agents?: { id: string; name: string }[];
  onSelectAgent?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const draggedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Stick to the bottom only while the user is already there — so scrolling up
  // to read isn't yanked back down by polls.
  const atBottomRef = useRef(true);
  const [attaching, setAttaching] = useState(false);
  const stats = useAgentStats(agentId);
  const working = stats?.status === 'busy';

  // Switching agents (dashboard picker) clears the conversation so stale turns
  // from the previous agent don't linger before the new transcript loads.
  useEffect(() => {
    setTurns([]);
    setInput('');
  }, [agentId]);
  const awaiting = !!stats?.awaitingInput;
  const promptOptions = stats?.promptOptions ?? [];
  const multiSelect = !!stats?.promptMultiSelect;
  // Multi-select checkbox state, reset whenever a new question appears.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // While a selector is open, lock the composer (free typing would corrupt the
  // selection) — except after picking "Type something", which opens a text
  // field we want the user to type into.
  const [freeText, setFreeText] = useState(false);
  useEffect(() => {
    setPicked(new Set());
    setFreeText(false);
  }, [stats?.promptText, awaiting]);
  const composerLocked = awaiting && !freeText;
  // Faithful colored HTML render of the open selector (incl. ASCII previews) —
  // the text parse is lossy for structured prompts, so we show the real thing.
  const [promptHtml, setPromptHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !awaiting) {
      setPromptHtml(null);
      return;
    }
    let alive = true;
    const load = () =>
      getPromptHtml(agentId)
        .then((r) => alive && setPromptHtml(r.html))
        .catch(() => {});
    void load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, awaiting, agentId]);
  const lockedRef = useRef(composerLocked);
  lockedRef.current = composerLocked;
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
    atBottomRef.current = true; // open pinned to the latest message
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

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Follow new content only when pinned to the bottom (and always on open).
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [turns, open, working]);

  // Type-to-focus: while the dock is open, starting to type anywhere (outside a
  // field) drops focus into the composer so the keystroke lands there.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lockedRef.current) return; // selector open — don't grab keys into composer
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Insert a newline at the caret (Ctrl/Cmd+Enter). The value's \n is sent to
  // the TUI as Ctrl+J (= a newline in Claude Code), so messages stay multi-line.
  const insertNewline = () => {
    const ta = inputRef.current;
    const start = ta?.selectionStart ?? input.length;
    const end = ta?.selectionEnd ?? input.length;
    const next = `${input.slice(0, start)}\n${input.slice(end)}`;
    setInput(next);
    requestAnimationFrame(() => {
      if (ta) ta.selectionStart = ta.selectionEnd = start + 1;
    });
  };

  const send = () => {
    // Normalize to \n; in Claude's TUI a raw \n (0x0A) is Ctrl+J = newline,
    // while \r (0x0D) is Enter = submit — so newlines never submit early.
    const text = input.trim().replace(/\r\n?/g, '\n');
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'data', data: text }));
    // Submit AFTER a gap. Sending the text and Enter back-to-back makes Claude's
    // TUI treat them as one paste, turning Enter into a literal newline instead
    // of a submit (the message just sits in the box). The delay lets paste
    // detection settle so the Enter registers as submit.
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: '\r' }));
    }, 250);
    atBottomRef.current = true; // sending always snaps back to the latest
    // Optimistic echo until the transcript catches up.
    setTurns((prev) => [
      ...prev,
      { role: 'user', ts: Date.now(), items: [{ kind: 'text', text }] },
    ]);
    setInput('');
  };

  // Answer an open selector by driving it. Claude's selectors always open with
  // option 1 highlighted, so we step down to the n-th option (↓ × n-1) then
  // Enter — no ↑ spam (↑ wraps around and a fast burst drops keys). Keys are
  // sent one at a time, slightly spaced, so none are coalesced/dropped. The
  // "Type something" option selects into a text field — the user then types in
  // the composer as usual.
  // Send a list of keystrokes to the selector, spaced so none are dropped.
  const driveKeys = (keys: string[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    keys.forEach((k, idx) =>
      setTimeout(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: k }));
      }, idx * 70),
    );
  };

  const DOWN = '\x1b[B';
  const ENTER = '\r';
  const SPACE = ' ';

  // Single-select: step down to the n-th option, then Enter.
  const answerOption = (n: number) => driveKeys([...Array(Math.max(0, n - 1)).fill(DOWN), ENTER]);

  // Multi-select: walk the checkbox rows top-to-bottom, toggling (Space) the
  // picked ones, then step onto the Submit row and Enter. That lands on the
  // "Submit answers / Cancel" review screen, which surfaces as a normal
  // single-select prompt the user confirms with one more click.
  const submitMulti = () => {
    const checkable = promptOptions.filter((o) => o.checkable);
    const keys: string[] = [];
    checkable.forEach((o, p) => {
      if (picked.has(o.n)) keys.push(SPACE);
      if (p < checkable.length - 1) keys.push(DOWN);
    });
    keys.push(DOWN, ENTER); // step from last checkbox onto Submit, then confirm
    driveKeys(keys);
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
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="border-separator bg-surface fixed right-4 bottom-4 z-50 flex h-[70vh] max-h-[calc(100vh-2rem)] w-[min(400px,calc(100vw-2rem))] origin-bottom-right flex-col overflow-hidden rounded-2xl border shadow-[0_16px_60px_rgba(0,0,0,0.55)]"
          >
            <header
              onPointerDown={(e) => dragControls.start(e)}
              className="border-separator bg-surface-secondary flex cursor-grab items-center justify-between border-b px-3.5 py-3 select-none active:cursor-grabbing"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                <LuMessageSquare className="text-muted size-4 shrink-0" />
                {agents ? (
                  <select
                    value={agentId}
                    onChange={(e) => onSelectAgent?.(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="max-w-[180px] cursor-pointer truncate bg-transparent font-semibold outline-none"
                    aria-label="Choose agent"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  agentId
                )}
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

            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="min-h-0 flex-1 space-y-4 overflow-auto p-3"
            >
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
                  {/* API/transport errors are not real replies — set them apart
                      with a red alert card so they can't be mistaken for one. */}
                  {t.error ? (
                    <div className="border-danger/50 bg-danger/10 space-y-1 rounded-xl border px-3 py-2 text-sm">
                      <div className="text-danger flex items-center gap-1.5 font-semibold">
                        <LuTriangleAlert className="size-3.5 shrink-0" />
                        Error
                      </div>
                      <p className="text-foreground whitespace-pre-wrap">
                        {t.items.map((it) => it.text ?? '').join('\n')}
                      </p>
                    </div>
                  ) : (
                    /* User → bubble on the right; assistant → markdown on the left. */
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
                          <ToolItem key={j} name={it.name ?? ''} detail={it.detail} />
                        ),
                      )}
                    </div>
                  )}
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
                TUI-only and never reach the transcript. We parse their options
                off the screen and answer by driving the selector; if we can't
                parse options, we fall back to routing the user to the Terminal. */}
            <AnimatePresence>
              {awaiting && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="border-warning/40 bg-warning/10 mx-2 mb-1 rounded-xl border p-2.5"
                >
                  {promptHtml ? (
                    // Faithful render of the actual selector (colors, ASCII previews).
                    <div
                      className="chat-prompt border-separator mb-1 overflow-auto rounded-lg border"
                      dangerouslySetInnerHTML={{ __html: promptHtml }}
                    />
                  ) : (
                    <p className="text-foreground text-sm font-medium">
                      {stats?.promptText
                        ? `“${stats.promptText}”`
                        : 'The agent is asking a question'}
                    </p>
                  )}

                  {multiSelect && promptOptions.some((o) => o.checkable) ? (
                    /* Multi-select: toggle checkboxes, then Submit. */
                    <div className="mt-2 space-y-1.5">
                      <div className="max-h-44 space-y-1 overflow-auto">
                        {promptOptions
                          .filter((o) => o.checkable && !/^type something/i.test(o.label))
                          .map((o) => {
                            const on = picked.has(o.n);
                            return (
                              <button
                                key={o.n}
                                onClick={() =>
                                  setPicked((prev) => {
                                    const s = new Set(prev);
                                    if (s.has(o.n)) s.delete(o.n);
                                    else s.add(o.n);
                                    return s;
                                  })
                                }
                                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
                                  on
                                    ? 'border-accent bg-accent/10'
                                    : 'border-separator bg-surface hover:bg-surface-secondary'
                                }`}
                              >
                                <span
                                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                                    on
                                      ? 'border-accent bg-accent text-accent-foreground'
                                      : 'border-separator'
                                  }`}
                                >
                                  {on && <LuCheck className="size-3" />}
                                </span>
                                <span className="min-w-0">{o.label}</span>
                              </button>
                            );
                          })}
                      </div>
                      <Button size="sm" onPress={submitMulti} isDisabled={picked.size === 0}>
                        Submit{picked.size > 0 ? ` (${picked.size})` : ''}
                      </Button>
                    </div>
                  ) : promptOptions.length > 0 ? (
                    /* Single-select: compact answer chips (the render above is
                       the question; these are just the clickable answers). */
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {promptOptions.map((o) => (
                        <button
                          key={o.n}
                          onClick={() => {
                            answerOption(o.n);
                            // "Type something" opens a free-text field — unlock the
                            // composer and focus it so the typed answer lands there.
                            if (/^type something/i.test(o.label)) {
                              setFreeText(true);
                              setTimeout(() => inputRef.current?.focus(), 350);
                            }
                          }}
                          className="border-separator bg-surface hover:border-accent hover:bg-surface-secondary flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition-colors"
                        >
                          <span className="text-muted font-mono text-xs">{o.n}</span>
                          <span>{o.label}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      <p className="text-muted mt-0.5 text-xs">
                        Couldn’t read the choices — answer it in the Terminal.
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
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="p-2">
              <div
                className={`border-separator bg-surface flex flex-col gap-2 rounded-2xl border p-2.5 transition-colors ${
                  composerLocked ? 'opacity-60' : 'focus-within:border-accent'
                }`}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    if (e.ctrlKey || e.metaKey) {
                      // Ctrl/Cmd+Enter (and Shift+Enter) → newline, not send.
                      e.preventDefault();
                      insertNewline();
                    } else if (!e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={2}
                  disabled={composerLocked}
                  placeholder={composerLocked ? 'Pick an option above…' : 'Message the agent…'}
                  className="placeholder:text-muted max-h-32 min-h-0 resize-none bg-transparent text-sm outline-none disabled:cursor-not-allowed"
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Attach file"
                      disabled={composerLocked}
                      onClick={() => fileRef.current?.click()}
                      className="text-muted hover:text-foreground hover:bg-surface-secondary flex size-8 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <LuPaperclip className="size-4" />
                    </button>
                    <input ref={fileRef} type="file" hidden onChange={onPickFile} />
                    {attaching && <span className="text-muted text-xs">uploading…</span>}
                  </div>
                  <Button
                    isIconOnly
                    aria-label="Send"
                    onPress={send}
                    isDisabled={!input.trim() || composerLocked}
                  >
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
