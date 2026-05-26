'use client';

import { Button, Card, Chip, Dropdown, Label, Modal } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LuEllipsis } from 'react-icons/lu';
import {
  desktopUrl,
  getUpgradeInfo,
  removeAgent,
  startAgent,
  stopAgent,
  upgradeAgent,
  type Agent,
  type UpgradeInfo,
} from '@/lib/gateway';
import { AgentStatsInline } from './AgentStats';
import { ConfirmActionDialog } from './ConfirmActionDialog';

function statusColor(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'running') return 'success';
  if (status === 'exited' || status === 'dead') return 'danger';
  if (status === 'created' || status === 'paused' || status === 'restarting') return 'warning';
  return 'default';
}

function prettyImage(image: string): string {
  const sha = image.match(/^sha256:([0-9a-f]{12})/);
  return sha ? `image ${sha[1]}` : image;
}

function relativeTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Dialog = 'stop' | 'remove' | 'upgrade' | null;

export function AgentCard({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const router = useRouter();
  const running = agent.status === 'running';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeInfo | null>(null);

  const checkUpgrade = useCallback(async () => {
    try {
      setUpgrade(await getUpgradeInfo(agent.id));
    } catch {
      setUpgrade(null);
    }
  }, [agent.id]);

  useEffect(() => {
    if (running) void checkUpgrade();
  }, [running, checkUpgrade]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const onAction = (key: string) => {
    if (key === 'open') router.push(`/agents/${agent.id}/desktop`);
    else if (key === 'start') void act(() => startAgent(agent.id));
    else setDialog(key as Dialog);
  };

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* Live view: non-interactive scaled noVNC preview; click → open. */}
        <Link
          href={`/agents/${agent.id}/desktop`}
          aria-label={`Open ${agent.id}`}
          className="border-separator group relative flex aspect-video w-full shrink-0 items-center justify-center overflow-hidden border bg-black sm:w-56"
        >
          {running ? (
            <iframe
              title={`${agent.id} preview`}
              src={desktopUrl(agent.id)}
              tabIndex={-1}
              className="pointer-events-none h-4/5 w-4/5"
            />
          ) : (
            <span className="text-muted absolute inset-0 flex items-center justify-center text-xs">
              stopped
            </span>
          )}
          <span className="absolute inset-0 transition-colors group-hover:bg-white/5" />
        </Link>

        {/* Right column: info + a single actions menu. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate font-semibold">{agent.username || agent.id}</h3>
            <div className="flex shrink-0 items-center gap-1.5">
              <Chip color={statusColor(agent.status)} size="sm" variant="soft">
                {agent.status}
              </Chip>
              <Dropdown>
                <Button isIconOnly size="sm" variant="tertiary" aria-label="Agent actions">
                  <LuEllipsis className="size-4" />
                </Button>
                <Dropdown.Popover>
                  <Dropdown.Menu onAction={(key) => onAction(String(key))}>
                    <Dropdown.Item id="open" textValue="Open">
                      <Label>Open</Label>
                    </Dropdown.Item>
                    {running ? (
                      <Dropdown.Item id="stop" textValue="Stop">
                        <Label>Stop</Label>
                      </Dropdown.Item>
                    ) : (
                      <Dropdown.Item id="start" textValue="Start">
                        <Label>Start</Label>
                      </Dropdown.Item>
                    )}
                    {running && upgrade?.outdated ? (
                      <Dropdown.Item id="upgrade" textValue="Upgrade">
                        <Label>
                          Upgrade (v{upgrade.installed} → v{upgrade.latest})
                        </Label>
                      </Dropdown.Item>
                    ) : null}
                    <Dropdown.Item id="remove" textValue="Remove" variant="danger">
                      <Label>Remove</Label>
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            </div>
          </div>

          {/* Wraps to as many lines as needed — no truncation. */}
          <p className="text-muted font-mono text-xs break-words">
            {agent.username ? `${agent.id} · ` : ''}
            {prettyImage(agent.image)} · created {relativeTime(agent.createdAt)}
          </p>

          {running && <AgentStatsInline agentId={agent.id} />}
        </div>
      </div>

      <ConfirmActionDialog
        isOpen={dialog === 'stop'}
        onOpenChange={(o) => !o && setDialog(null)}
        confirmWord={agent.id}
        action="Stop"
        title="Stop agent"
        description={
          <>
            This stops the container and its running <code>claude</code> session.
          </>
        }
        onConfirm={() => act(() => stopAgent(agent.id))}
      />
      <ConfirmActionDialog
        isOpen={dialog === 'remove'}
        onOpenChange={(o) => !o && setDialog(null)}
        confirmWord={agent.id}
        action="Remove"
        title="Remove agent"
        description="This permanently deletes the container and its workspace. This cannot be undone."
        onConfirm={() => act(() => removeAgent(agent.id))}
      />

      <Modal>
        <Modal.Backdrop
          isOpen={dialog === 'upgrade'}
          onOpenChange={(o) => !o && setDialog(null)}
          isDismissable={!busy}
        >
          <Modal.Container>
            <Modal.Dialog className="sm:max-w-[460px]">
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>
                  Upgrade agent (v{upgrade?.installed} → v{upgrade?.latest})
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-muted mb-3 text-sm">
                  Runs the pending migrations against this live agent and restarts its supervisor.
                  The <code>claude</code> session restarts (transcript preserved); no data is lost.
                </p>
                <ul className="border-separator divide-separator divide-y border text-sm">
                  {upgrade?.pending.map((m) => (
                    <li key={m.version} className="flex gap-2 px-3 py-2">
                      <span className="text-muted font-mono">v{m.version}</span>
                      <span>{m.name}</span>
                    </li>
                  ))}
                </ul>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={busy}>
                  Cancel
                </Button>
                <Button
                  isDisabled={busy}
                  onPress={() =>
                    void act(async () => {
                      await upgradeAgent(agent.id);
                      await checkUpgrade();
                    }).then(() => setDialog(null))
                  }
                >
                  {busy ? 'Upgrading…' : 'Run migrations'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </Card>
  );
}
