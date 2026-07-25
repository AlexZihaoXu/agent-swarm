'use client';

import { use } from 'react';
import { DiscordClient } from '@/app/DiscordClient';

/** Full-screen Discord client for one agent — the "open fullscreen" target of
 *  the popup. Same component, so the two views never drift. */
export default function AgentDiscordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className="h-full min-h-0">
      <DiscordClient agentId={id} />
    </div>
  );
}
