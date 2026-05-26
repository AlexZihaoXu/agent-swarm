'use client';

import { Button, buttonVariants, Card, Chip } from '@heroui/react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LuSettings } from 'react-icons/lu';
import {
  desktopUrl,
  getImageStatus,
  listAgents,
  removeAgent,
  startAgent,
  stopAgent,
  type Agent,
} from '@/lib/gateway';
import { AgentStatsInline } from './AgentStats';
import { AgentUpdate } from './AgentUpdate';
import { ConfirmActionButton } from './ConfirmActionButton';
import { CreateAgentModal } from './CreateAgentModal';
import { ImageBanner } from './ImageBanner';
import { ThemeSwitch } from './ThemeSwitch';

function statusColor(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'running') return 'success';
  if (status === 'exited' || status === 'dead') return 'danger';
  if (status === 'created' || status === 'paused' || status === 'restarting') return 'warning';
  return 'default';
}

/** A bare sha256 digest is noise to an operator — show a short, readable form. */
function prettyImage(image: string): string {
  const sha = image.match(/^sha256:([0-9a-f]{12})/);
  if (sha) return `image ${sha[1]}`;
  return image;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" from an epoch-ms timestamp. */
function relativeTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function HomePage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAgents(await listAgents());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const [imagePresent, setImagePresent] = useState<boolean | null>(null);
  const refreshImage = useCallback(async () => {
    try {
      setImagePresent((await getImageStatus()).present);
    } catch {
      /* gateway unreachable — leave as-is */
    }
  }, []);

  // Initial load + light polling so status changes show up.
  useEffect(() => {
    void refresh();
    void refreshImage();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh, refreshImage]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent Swarm</h1>
          <p className="text-muted text-sm">Fleet of autonomous coding agents</p>
        </div>
        <div className="flex items-center gap-3">
          <ThemeSwitch />
          <Link
            href="/settings"
            aria-label="Settings"
            className={buttonVariants({ variant: 'tertiary', size: 'sm' })}
          >
            <LuSettings className="size-4" />
          </Link>
          <CreateAgentModal onCreated={() => void refresh()} disabled={imagePresent === false} />
        </div>
      </header>

      {imagePresent === false && (
        <ImageBanner image="agent-swarm/agent:dev" onBuilt={() => void refreshImage()} />
      )}

      {error && (
        <Card className="border-danger mb-6" variant="secondary">
          <Card.Content className="text-danger text-sm">
            Can&apos;t reach the gateway: {error}
          </Card.Content>
        </Card>
      )}

      {agents.length === 0 && !error ? (
        <p className="text-muted text-sm">No agents yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {agents.map((a) => {
            const running = a.status === 'running';
            return (
              <Card key={a.id}>
                <div className="flex flex-col gap-4 sm:flex-row">
                  {/* Live view: a non-interactive, scaled noVNC preview; click → open. */}
                  <Link
                    href={`/agents/${a.id}/desktop`}
                    aria-label={`Open ${a.id}`}
                    className="border-separator group relative block aspect-video w-full shrink-0 overflow-hidden border bg-black sm:w-56"
                  >
                    {running ? (
                      <iframe
                        title={`${a.id} preview`}
                        src={desktopUrl(a.id)}
                        tabIndex={-1}
                        className="pointer-events-none h-full w-full"
                      />
                    ) : (
                      <span className="text-muted absolute inset-0 flex items-center justify-center text-xs">
                        stopped
                      </span>
                    )}
                    <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
                  </Link>

                  {/* Right column: info on top, options at the bottom. */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate font-semibold">{a.username || a.id}</h3>
                      <Chip color={statusColor(a.status)} size="sm" variant="soft">
                        {a.status}
                      </Chip>
                    </div>
                    <p className="text-muted truncate font-mono text-xs">
                      {a.username ? `${a.id} · ` : ''}
                      {prettyImage(a.image)} · created {relativeTime(a.createdAt)}
                    </p>
                    {running && <AgentStatsInline agentId={a.id} />}

                    <div className="mt-auto flex flex-wrap gap-2 pt-3">
                      <Link
                        href={`/agents/${a.id}/desktop`}
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                      >
                        Open
                      </Link>
                      {running && <AgentUpdate agentId={a.id} onUpgraded={() => void refresh()} />}
                      {running ? (
                        <ConfirmActionButton
                          confirmWord={a.id}
                          action="Stop"
                          title="Stop agent"
                          description={
                            <>
                              This stops the container and its running <code>claude</code> session.
                            </>
                          }
                          isDisabled={busy}
                          onConfirm={() => run(() => stopAgent(a.id))}
                        >
                          Stop
                        </ConfirmActionButton>
                      ) : (
                        <Button
                          isDisabled={busy}
                          size="sm"
                          variant="tertiary"
                          onPress={() => void run(() => startAgent(a.id))}
                        >
                          Start
                        </Button>
                      )}
                      <ConfirmActionButton
                        confirmWord={a.id}
                        action="Remove"
                        title="Remove agent"
                        description="This permanently deletes the container and its workspace. This cannot be undone."
                        isDisabled={busy}
                        onConfirm={() => run(() => removeAgent(a.id))}
                      >
                        Remove
                      </ConfirmActionButton>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
