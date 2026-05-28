'use client';

import { Button } from '@heroui/react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LuArrowUp,
  LuCheck,
  LuChevronDown,
  LuCircle,
  LuCircleCheck,
  LuListChecks,
  LuListTodo,
  LuPaperclip,
  LuTerminal,
  LuTriangleAlert,
  LuWrench,
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
  type AgentTask,
  type ChatTodo,
  type ChatTurn,
} from '@/lib/gateway';
import { useAgentStats } from './AgentStats';

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

/** A plan from plan mode (ExitPlanMode) — rendered as a titled card with the
 * full plan markdown, rather than a truncated tool one-liner. */
function PlanCard({ text }: { text: string }) {
  return (
    <div className="border-accent/40 bg-accent/5 space-y-1.5 rounded-xl border p-3">
      <div className="text-accent flex items-center gap-1.5 text-sm font-semibold">
        <LuListChecks className="size-4 shrink-0" />
        Plan
      </div>
      <div className="chat-md">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** A to-do list (TodoWrite) — a checklist that marks steps done as the agent
 * works through them. */
function TodosCard({ todos }: { todos: ChatTodo[] }) {
  return (
    <div className="border-separator bg-surface-secondary/40 space-y-2 rounded-xl border p-3">
      <div className="text-muted flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
        <LuListTodo className="size-3.5" />
        Tasks
      </div>
      <ul className="space-y-1.5">
        {todos.map((td, i) => {
          const done = td.status === 'completed';
          const active = td.status === 'in_progress';
          return (
            <li key={i} className="flex items-start gap-2 text-sm">
              {done ? (
                <LuCircleCheck className="text-success mt-0.5 size-4 shrink-0" />
              ) : active ? (
                <motion.span
                  className="bg-accent mt-1.5 size-2 shrink-0 rounded-full"
                  animate={{ opacity: [1, 0.3, 1], scale: [1, 1.25, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                />
              ) : (
                <LuCircle className="text-muted mt-0.5 size-4 shrink-0" />
              )}
              <span
                className={
                  done
                    ? 'text-muted line-through'
                    : active
                      ? 'text-foreground font-medium'
                      : 'text-foreground'
                }
              >
                {active && td.activeForm ? td.activeForm : td.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Status icon for a task/todo: completed check, in-progress pulse, or pending. */
function StatusIcon({ status }: { status: string }) {
  if (status === 'completed')
    return <LuCircleCheck className="text-success mt-0.5 size-4 shrink-0" />;
  if (status === 'in_progress')
    return (
      <motion.span
        className="bg-accent mt-1.5 size-2 shrink-0 rounded-full"
        animate={{ opacity: [1, 0.3, 1], scale: [1, 1.25, 1] }}
        transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
      />
    );
  return <LuCircle className="text-muted mt-0.5 size-4 shrink-0" />;
}

/** Live task checklist (TaskCreate/TaskUpdate), pinned above the conversation —
 * shows steps getting marked off as the agent works. Collapsible; when open it
 * may take up to half the panel height (scrolling beyond that). */
function TasksPanel({ tasks }: { tasks: AgentTask[] }) {
  const [open, setOpen] = useState(true);
  const done = tasks.filter((t) => t.status === 'completed').length;
  return (
    <div className="border-separator bg-surface-secondary/50 relative z-10 shrink-0 border-b shadow-[0_4px_12px_-6px_rgba(0,0,0,0.15)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-muted hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold tracking-wide uppercase"
      >
        <LuChevronDown className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        <LuListTodo className="size-3.5" />
        Tasks
        <span className="text-muted/70 lowercase">
          {done}/{tasks.length} done
        </span>
      </button>
      {/* Collapse via grid-rows (0fr↔1fr): animates smoothly AND sizes to the
          content when open (so nothing gets clipped); long lists scroll at 45vh. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <ul className="max-h-[45vh] space-y-1 overflow-auto px-3 pb-2">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2 text-sm">
                <StatusIcon status={t.status} />
                <span
                  className={
                    t.status === 'completed'
                      ? 'text-muted line-through'
                      : t.status === 'in_progress'
                        ? 'text-foreground font-medium'
                        : 'text-foreground'
                  }
                >
                  {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
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
 * One agent's chat: the conversation (polled transcript, typed-out replies,
 * tool calls, interactive-selector answering) plus the composer. Container-
 * agnostic — fills its parent. `active` gates the transcript poll + send socket
 * (set false to disconnect when hidden).
 */
export function ChatPanel({ agentId, active }: { agentId: string; active: boolean }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const [attaching, setAttaching] = useState(false);
  const stats = useAgentStats(agentId);
  const working = stats?.status === 'busy';
  const tasks = stats?.tasks ?? [];

  // Reset when the agent changes (so stale turns don't linger before reload).
  useEffect(() => {
    setTurns([]);
    setInput('');
  }, [agentId]);

  const awaiting = !!stats?.awaitingInput;
  const promptOptions = stats?.promptOptions ?? [];
  const multiSelect = !!stats?.promptMultiSelect;
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [freeText, setFreeText] = useState(false);
  useEffect(() => {
    setPicked(new Set());
    setFreeText(false);
  }, [stats?.promptText, awaiting]);
  const composerLocked = awaiting && !freeText;

  const [promptHtml, setPromptHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !awaiting) {
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
  }, [active, awaiting, agentId]);
  const lockedRef = useRef(composerLocked);
  lockedRef.current = composerLocked;
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

  // While active: poll the transcript and keep a send socket to the session.
  useEffect(() => {
    if (!active) return;
    atBottomRef.current = true;
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
  }, [active, agentId, refresh]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [turns, active, working]);

  // Type-to-focus: typing anywhere (outside a field) drops focus into composer.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (lockedRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // Insert a newline at the caret (Ctrl/Cmd+Enter). \n is sent to the TUI as
  // Ctrl+J (= a newline in Claude Code), so messages stay multi-line.
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
    const text = input.trim().replace(/\r\n?/g, '\n');
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'data', data: text }));
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: '\r' }));
    }, 250);
    atBottomRef.current = true;
    setTurns((prev) => [
      ...prev,
      { role: 'user', ts: Date.now(), items: [{ kind: 'text', text }] },
    ]);
    setInput('');
  };

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
  const answerOption = (n: number) => driveKeys([...Array(Math.max(0, n - 1)).fill(DOWN), ENTER]);
  const submitMulti = () => {
    const checkable = promptOptions.filter((o) => o.checkable);
    const keys: string[] = [];
    checkable.forEach((o, p) => {
      if (picked.has(o.n)) keys.push(SPACE);
      if (p < checkable.length - 1) keys.push(DOWN);
    });
    keys.push(DOWN, ENTER);
    driveKeys(keys);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tasks.length > 0 && <TasksPanel tasks={tasks} />}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="chat-convo min-h-0 flex-1 space-y-4 overflow-auto p-3"
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
                  ) : it.kind === 'plan' ? (
                    <PlanCard key={j} text={it.text ?? ''} />
                  ) : it.kind === 'todos' ? (
                    <TodosCard key={j} todos={it.todos ?? []} />
                  ) : (
                    <ToolItem key={j} name={it.name ?? ''} detail={it.detail} />
                  ),
                )}
              </div>
            )}
          </motion.div>
        ))}

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
              <div
                className="chat-prompt border-separator mb-1 overflow-auto rounded-lg border"
                dangerouslySetInnerHTML={{ __html: promptHtml }}
              />
            ) : (
              <p className="text-foreground text-sm font-medium">
                {stats?.promptText ? `“${stats.promptText}”` : 'The agent is asking a question'}
              </p>
            )}

            {multiSelect && promptOptions.some((o) => o.checkable) ? (
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
              <div className="mt-2 flex flex-wrap gap-1.5">
                {promptOptions.map((o) => (
                  <button
                    key={o.n}
                    onClick={() => {
                      answerOption(o.n);
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
    </div>
  );
}
