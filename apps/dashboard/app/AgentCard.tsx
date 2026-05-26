'use client';

import { Button, Card, Chip, Dropdown, Label, Modal } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import {
  getUpgradeInfo,
  removeAgent,
  screenshotUrl,
  startAgent,
  stopAgent,
  upgradeAgent,
  type Agent,
  type UpgradeInfo,
} from '@/lib/gateway';
import { agentChip, AgentStatsInline, useAgentStats } from './AgentStats';
import { ConfirmActionDialog } from './ConfirmActionDialog';

const DEFAULT_IMAGE = 'agent-swarm/agent:dev';

function prettyImage(image: string): string {
  const sha = image.match(/^sha256:([0-9a-f]{12})/);
  return sha ? `image ${sha[1]}` : image;
}

/**
 * Secondary line under the title: the hostname (when a display name is set) and
 * the image — but only when it's a custom image. The default agent image (or its
 * untagged sha) is hidden, since every agent uses it.
 */
function subline(agent: Agent): string {
  const parts: string[] = [];
  if (agent.username) parts.push(agent.id);
  const isDefault = agent.image === DEFAULT_IMAGE || /^sha256:/.test(agent.image);
  if (!isDefault) parts.push(prettyImage(agent.image));
  return parts.join(' · ');
}

type Dialog = 'stop' | 'remove' | 'upgrade' | null;

/** Low-res desktop thumbnail that refreshes every few seconds (cheap, unlike a
 *  live VNC stream per card). Keeps retrying if a frame fails to load. */
function PreviewImage({ agentId }: { agentId: string }) {
  const [ts, setTs] = useState(() => Date.now());
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTs(Date.now()), 2500);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <img
        src={`${screenshotUrl(agentId)}?t=${ts}`}
        alt=""
        onLoad={() => setOk(true)}
        onError={() => setOk(false)}
        className={ok ? 'h-full w-full object-contain' : 'hidden'}
      />
      {!ok && (
        <span className="text-muted absolute inset-0 flex items-center justify-center text-xs">
          connecting…
        </span>
      )}
    </>
  );
}

export function AgentCard({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const router = useRouter();
  const running = agent.status === 'running';
  const stats = useAgentStats(agent.id, { enabled: running });
  const chip = agentChip(agent.status, stats?.status);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeInfo | null>(null);
  // Cursor position for the right-click context menu (null = closed).
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

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
    setMenuPos(null);
    if (key === 'open') router.push(`/agents/${agent.id}/desktop`);
    else if (key === 'start') void act(() => startAgent(agent.id));
    else setDialog(key as Dialog);
  };

  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  return (
    <Card onContextMenu={openMenu}>
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* Live view: non-interactive scaled noVNC preview; click → open. */}
        <Link
          href={`/agents/${agent.id}/desktop`}
          aria-label={`Open ${agent.id}`}
          className="border-separator group relative block aspect-video w-full shrink-0 overflow-hidden border bg-black sm:w-44"
        >
          {running ? (
            <PreviewImage agentId={agent.id} />
          ) : (
            <span className="text-muted absolute inset-0 flex items-center justify-center text-xs">
              stopped
            </span>
          )}
          <span className="absolute inset-0 transition-colors group-hover:bg-white/5" />
        </Link>

        {/* Right column: title, info, then status + live stats. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="truncate font-semibold">{agent.username || agent.id}</h3>
          {subline(agent) && (
            <p className="text-muted font-mono text-xs break-words">{subline(agent)}</p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Chip color={chip.color} size="sm" variant="soft">
              {chip.working && (
                <motion.span
                  className="bg-success mr-1 inline-block size-1.5 rounded-full align-middle"
                  animate={{ opacity: [1, 0.25, 1], scale: [1, 1.3, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}
              {chip.label}
            </Chip>
            {running && <AgentStatsInline stats={stats} />}
          </div>
          <p className="text-muted/70 mt-1 text-[11px]">Right-click for actions</p>
        </div>
      </div>

      {/* Right-click context menu (anchored to an invisible element at the cursor). */}
      <Dropdown isOpen={menuPos !== null} onOpenChange={(o) => !o && setMenuPos(null)}>
        <Button
          aria-hidden="true"
          excludeFromTabOrder
          style={{
            position: 'fixed',
            left: menuPos?.x ?? 0,
            top: menuPos?.y ?? 0,
            width: 0,
            height: 0,
            minHeight: 0,
            padding: 0,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
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
