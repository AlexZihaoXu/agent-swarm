'use client';

import { Button, Input, TextField, toast } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { LuSend } from 'react-icons/lu';
import { listGroupMessages, sendGroupMessage, type Agent, type GroupMessage } from '@/lib/gateway';
import { Identicon } from '@/lib/identicon';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function clock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * The shared chat for one group. Polls the group's running log (~2s) and posts
 * as the human operator — which the gateway fans out to every agent in the
 * group. Agent messages appear left with an identicon + name; the operator's own
 * messages align right.
 */
export function GroupChatPanel({
  groupId,
  agents,
  active,
}: {
  groupId: string;
  /** Fleet, so a sender's avatar matches their (reshuffleable) seed elsewhere. */
  agents: Agent[];
  active: boolean;
}) {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  // Resolve a group message's sender to a stable avatar seed: prefer the live
  // agent's current avatarSeed (so a reshuffle reflects here too), else the id.
  const seedFor = (m: GroupMessage) => {
    const a = agents.find((x) => x.id === m.fromId);
    return a?.avatarSeed || a?.id || m.fromId || m.from;
  };
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Reset when switching groups so the previous group's log doesn't flash.
  useEffect(() => setMessages([]), [groupId]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () =>
      listGroupMessages(groupId)
        .then((m) => alive && setMessages(m))
        .catch(() => {});
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [groupId, active]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await sendGroupMessage(groupId, t);
      setText('');
      setMessages(await listGroupMessages(groupId));
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Failed to send.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <p className="text-muted mt-8 text-center text-sm">
            No messages yet — say hi to the group.
          </p>
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((m) => {
              const human = m.kind === 'human';
              return (
                <motion.div
                  key={m.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className={`flex items-end gap-2 ${human ? 'flex-row-reverse' : ''}`}
                >
                  {human ? (
                    <span className="bg-accent/15 text-accent flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold">
                      You
                    </span>
                  ) : (
                    <Identicon
                      seed={seedFor(m)}
                      title={m.from}
                      className="size-7 shrink-0 rounded-md"
                    />
                  )}
                  <div className={`max-w-[80%] ${human ? 'items-end text-right' : ''}`}>
                    <div
                      className={`mb-0.5 flex items-baseline gap-1.5 ${human ? 'justify-end' : ''}`}
                    >
                      <span className="text-xs font-medium">{human ? 'You' : m.from}</span>
                      {!human && <span className="text-muted text-[10px]">agent</span>}
                      <span className="text-muted text-[10px]">{clock(m.ts)}</span>
                    </div>
                    <div
                      className={`inline-block rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap ${
                        human
                          ? 'bg-accent text-accent-foreground rounded-br-md'
                          : 'bg-surface-secondary rounded-bl-md'
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-separator flex items-end gap-2 border-t px-3 py-3">
        <TextField
          className="flex-1"
          value={text}
          onChange={setText}
          aria-label="Message the group"
        >
          <Input
            placeholder="Message the group…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </TextField>
        <Button onPress={() => void send()} isDisabled={busy || !text.trim()} aria-label="Send">
          <LuSend className="size-4" />
        </Button>
      </div>
    </div>
  );
}
