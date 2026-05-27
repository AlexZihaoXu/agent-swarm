'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '@/lib/gateway';
import { ChatWidget } from './agents/[id]/ChatWidget';

/**
 * The floating chat dock on the fleet dashboard, with an agent picker in its
 * header — so you can talk to any running agent without opening its page. Only
 * running agents have a live `claude` session to chat with.
 */
export function DashboardChat({ agents }: { agents: Agent[] }) {
  const running = agents.filter((a) => a.status === 'running');
  const ids = running.map((a) => a.id).join(',');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default to the first running agent; keep the current pick if it's still
  // running, otherwise fall back (or clear when none are running).
  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    setSelectedId((cur) => (cur && list.includes(cur) ? cur : (list[0] ?? null)));
  }, [ids]);

  if (!selectedId) return null;
  const pick = running.map((a) => ({ id: a.id, name: a.username || a.id }));
  return <ChatWidget agentId={selectedId} agents={pick} onSelectAgent={setSelectedId} />;
}
