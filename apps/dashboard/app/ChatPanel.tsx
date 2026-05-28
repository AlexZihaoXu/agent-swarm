'use client';

import { Button } from '@heroui/react';
import { animate, motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuBrain,
  LuCheck,
  LuChevronDown,
  LuCircle,
  LuCircleCheck,
  LuClock,
  LuImageOff,
  LuListChecks,
  LuSquare,
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
  terminalHttpBase,
  terminalWsUrl,
  uploadToAgent,
  type AgentTask,
  type ChatTodo,
  type ChatTurn,
} from '@/lib/gateway';
import { useAgentStats } from './AgentStats';

/** The plain-text of a transcript turn, trimmed — for matching queued sends. */
const userTurnText = (t: ChatTurn): string =>
  t.items
    .map((it) => it.text ?? '')
    .join('')
    .trim();

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

/** Extended-thinking block — collapsible (default closed); header shows an
 * estimated token count, body is the reasoning. */
function ThinkingCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tk = Math.max(1, Math.round(text.length / 4));
  const tkLabel = tk >= 1000 ? `${(tk / 1000).toFixed(1)}k` : String(tk);
  return (
    <div className="border-separator/60 bg-surface-secondary/30 rounded-xl border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-muted hover:text-foreground flex w-full items-center gap-1.5 px-3 py-1.5 text-xs"
      >
        <LuBrain className="size-3.5 shrink-0" />
        <span className="font-medium">Thinking</span>
        <span className="text-muted/70">~{tkLabel} tokens</span>
        <LuChevronDown
          className={`ml-auto size-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <div className="text-muted max-h-60 overflow-auto px-3 pb-2.5 text-xs whitespace-pre-wrap italic">
          {text}
        </div>
      )}
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

/** Status icon for a task/todo: completed check, in-progress pulse, or pending.
 * The glyph cross-fades/pops when the status changes. */
function StatusIcon({ status }: { status: string }) {
  const glyph =
    status === 'completed' ? (
      <LuCircleCheck className="text-success size-4" />
    ) : status === 'in_progress' ? (
      <motion.span
        className="bg-accent size-2 rounded-full"
        animate={{ opacity: [1, 0.3, 1], scale: [1, 1.25, 1] }}
        transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
      />
    ) : (
      <LuCircle className="text-muted size-4" />
    );
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.4 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="flex items-center justify-center"
        >
          {glyph}
        </motion.span>
      </AnimatePresence>
    </span>
  );
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
          <ul className="max-h-[45vh] overflow-auto px-3 pb-2">
            <AnimatePresence initial={false}>
              {tasks.map((t) => (
                <motion.li
                  key={t.id}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="flex items-start gap-2 overflow-hidden py-0.5 text-sm"
                >
                  <StatusIcon status={t.status} />
                  <span
                    className={`transition-colors duration-300 ${
                      t.status === 'completed'
                        ? 'text-muted line-through'
                        : t.status === 'in_progress'
                          ? 'text-foreground font-medium'
                          : 'text-foreground'
                    }`}
                  >
                    {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Live generated-token count that eases (lerps) to each new value and shifts
 *  colour by magnitude as it climbs — same idea as the dashboard usage rings. */
function AnimatedTokens({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const controls = animate(prev.current, value, {
      duration: 0.6,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(v),
    });
    prev.current = value;
    return () => controls.stop();
  }, [value]);
  const n = Math.round(display);
  const text = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  // muted → accent → warning → danger as the response grows.
  const color =
    n >= 30000
      ? 'text-danger'
      : n >= 10000
        ? 'text-warning'
        : n >= 2000
          ? 'text-accent'
          : 'text-muted/70';
  return <span className={`tabular-nums transition-colors duration-700 ${color}`}>{text}</span>;
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
 * A captured screenshot in the chat. Screenshots live in a size-capped temp
 * folder on the agent and are evicted once it fills up, so an older one may be
 * gone (404 / failed load). When that happens we replace the broken <img> with
 * a tidy "no longer available" notice instead of a broken-image glyph.
 */
function ChatImage({
  agentId,
  file,
  onOpen,
}: {
  agentId: string;
  file: string;
  onOpen: (url: string) => void;
}) {
  const [lost, setLost] = useState(false);
  const url = `${terminalHttpBase(agentId)}api/shots/${file}`;
  if (lost) {
    return (
      <div className="border-separator text-muted/80 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs">
        <LuImageOff className="size-4 shrink-0" />
        Screenshot no longer available
      </div>
    );
  }
  return (
    <img
      src={url}
      alt="screenshot"
      loading="lazy"
      onError={() => setLost(true)}
      onClick={() => onOpen(url)}
      className="border-separator max-h-80 w-auto max-w-full cursor-zoom-in rounded-lg border"
    />
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
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Messages sent locally that haven't appeared in the polled transcript yet
  // (e.g. queued while the agent is busy). Rendered as "queued" so they don't
  // vanish when the 2s poll replaces `turns` with the server transcript.
  const [pending, setPending] = useState<{ text: string; ts: number; threshold: number }[]>([]);
  const stats = useAgentStats(agentId);
  const working = stats?.status === 'busy';
  const tasks = stats?.tasks ?? [];

  // Reset when the agent changes (so stale turns don't linger before reload).
  useEffect(() => {
    setTurns([]);
    setInput('');
    setPending([]);
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
      // Reconcile pending: a message is delivered once the transcript holds at
      // least `threshold` user turns with its text. Also age out anything stuck
      // for >90s (lost send, or a text-normalization mismatch) so a bubble can't
      // hang as "queued" forever.
      setPending((p) => {
        if (!p.length) return p;
        const count = new Map<string, number>();
        for (const t of next) {
          if (t.role !== 'user') continue;
          const tx = userTurnText(t);
          count.set(tx, (count.get(tx) ?? 0) + 1);
        }
        const now = Date.now();
        return p.filter((pi) => now - pi.ts <= 90_000 && (count.get(pi.text) ?? 0) < pi.threshold);
      });
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
    // Track it as pending until it lands in the transcript. `threshold` = how many
    // user turns with this exact text must exist before we consider THIS one
    // delivered: existing matching turns + already-pending duplicates + 1. This
    // makes duplicate/identical messages reconcile one-to-one (not all at once),
    // and avoids a new message matching an older identical turn.
    setPending((p) => {
      const inTranscript = turns.filter(
        (t) => t.role === 'user' && userTurnText(t) === text,
      ).length;
      const inPending = p.filter((pi) => pi.text === text).length;
      return [...p, { text, ts: Date.now(), threshold: inTranscript + inPending + 1 }];
    });
    setInput('');
  };

  /** Send Esc over the pty to interrupt the agent's current turn. */
  const interrupt = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: '\x1b' }));
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
    <>
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
                    ) : it.kind === 'thinking' ? (
                      <ThinkingCard key={j} text={it.text ?? ''} />
                    ) : it.kind === 'plan' ? (
                      <PlanCard key={j} text={it.text ?? ''} />
                    ) : it.kind === 'todos' ? (
                      <TodosCard key={j} todos={it.todos ?? []} />
                    ) : it.kind === 'image' && it.file ? (
                      <ChatImage key={j} agentId={agentId} file={it.file} onOpen={setLightbox} />
                    ) : (
                      <ToolItem key={j} name={it.name ?? ''} detail={it.detail} />
                    ),
                  )}
                </div>
              )}
            </motion.div>
          ))}

          {pending.map((p, i) => (
            <motion.div
              key={`pending-${p.ts}-${i}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="flex flex-col items-end gap-0.5"
            >
              <div className="bg-surface-secondary/60 text-surface-secondary-foreground max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm font-medium">
                <p className="whitespace-pre-wrap">{p.text}</p>
              </div>
              <span className="text-muted/70 flex items-center gap-1 pr-1 text-[11px]">
                <LuClock className="size-3" />
                {working ? 'queued' : 'sending…'}
              </span>
            </motion.div>
          ))}

          {working && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="flex items-center gap-2 text-xs"
            >
              {stats?.activity?.verb ? (
                // Mirror the TUI's flashing gerund (e.g. "Flibbertigibbeting…").
                <motion.span
                  className="text-warning font-medium"
                  animate={{ opacity: [1, 0.45, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                >
                  {stats.activity.verb}…
                </motion.span>
              ) : (
                <span className="text-muted flex items-center gap-2">
                  <TypingDots />
                  working
                </span>
              )}
              {stats?.activity && (stats.activity.elapsed || stats.activity.genTokens != null) && (
                <span className="text-muted/70 flex items-center gap-1 tabular-nums">
                  {stats.activity.elapsed && <span>{stats.activity.elapsed}</span>}
                  {stats.activity.genTokens != null && (
                    <span className="flex items-center gap-0.5">
                      {stats.activity.elapsed && <span className="mr-0.5">·</span>}
                      <LuArrowDown className="size-3" />
                      <AnimatedTokens value={stats.activity.genTokens} /> tokens
                    </span>
                  )}
                </span>
              )}
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
              <div className="flex items-center gap-2">
                {working && (
                  <Button
                    isIconOnly
                    variant="secondary"
                    aria-label="Stop (interrupt the agent)"
                    onPress={interrupt}
                  >
                    <LuSquare className="size-3.5 fill-current" />
                  </Button>
                )}
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
      </div>

      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
            className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
          >
            <motion.img
              src={lightbox}
              alt="screenshot"
              initial={{ scale: 0.96 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.96 }}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
