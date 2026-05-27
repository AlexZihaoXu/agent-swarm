'use client';

import { Button, Card, Chip, Dropdown, Input, Label, Modal, TextField, toast } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { LuDices } from 'react-icons/lu';
import {
  getUpgradeInfo,
  removeAgent,
  renameAgent,
  screenshotUrl,
  startAgent,
  stopAgent,
  upgradeAgent,
  type Agent,
  type UpgradeInfo,
} from '@/lib/gateway';
import { randomName } from '@/lib/names';
import { agentChip, AgentStatsInline, useAgentStats } from './AgentStats';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { PackageModal } from './PackageModal';

type Dialog = 'stop' | 'remove' | 'upgrade' | 'package' | 'rename' | null;

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

export function AgentCard({
  agent,
  onChanged,
  taken = [],
}: {
  agent: Agent;
  onChanged: () => void;
  /** Display names in use across the fleet — the rename generator avoids them. */
  taken?: string[];
}) {
  const router = useRouter();
  const running = agent.status === 'running';
  const stats = useAgentStats(agent.id, { enabled: running });
  const chip = agentChip(agent.status, stats?.status);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [renameValue, setRenameValue] = useState('');
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
    else {
      if (key === 'rename') setRenameValue(agent.username || agent.id);
      setDialog(key as Dialog);
    }
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
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate font-semibold">{agent.username || agent.id}</h3>
            <Chip color={chip.color} size="sm" variant="soft" className="shrink-0">
              {chip.working && (
                <motion.span
                  className="bg-success mr-1 inline-block size-1.5 rounded-full align-middle"
                  animate={{ opacity: [1, 0.25, 1], scale: [1, 1.3, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}
              {chip.label}
            </Chip>
          </div>
          <p className="text-muted truncate font-mono text-xs">{agent.id}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <AgentStatsInline stats={stats} />
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
            <Dropdown.Item id="rename" textValue="Rename">
              <Label>Rename…</Label>
            </Dropdown.Item>
            <Dropdown.Item id="package" textValue="Package">
              <Label>Package…</Label>
            </Dropdown.Item>
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
        description={
          <>
            This permanently deletes the container <strong>and its persistent disk</strong> (
            <code>.swarm_data/agents/{agent.id}</code> — Desktop, Documents, configs, everything).
            This cannot be undone. To keep its data, <strong>Package</strong> it first.
          </>
        }
        onConfirm={() => act(() => removeAgent(agent.id))}
      />

      <PackageModal
        agentId={agent.id}
        isOpen={dialog === 'package'}
        onOpenChange={(o) => !o && setDialog(null)}
        onChanged={onChanged}
      />

      <Modal>
        <Modal.Backdrop
          isOpen={dialog === 'rename'}
          onOpenChange={(o) => !o && setDialog(null)}
          isDismissable={!busy}
        >
          <Modal.Container>
            <Modal.Dialog className="sm:max-w-[400px]">
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>Rename agent</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <form
                  id={`rename-${agent.id}`}
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (renameValue.trim())
                      void act(() => renameAgent(agent.id, renameValue.trim())).then(() =>
                        setDialog(null),
                      );
                  }}
                >
                  <TextField
                    className="flex-1"
                    value={renameValue}
                    onChange={setRenameValue}
                    isRequired
                    autoFocus
                  >
                    <Label>Name</Label>
                    <Input placeholder="brave-otter" />
                  </TextField>
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label="Shuffle name"
                    onPress={() => {
                      const next = randomName(taken);
                      if (next) setRenameValue(next);
                      else toast.warning('All names are in use — type one manually.');
                    }}
                  >
                    <LuDices className="size-4" />
                  </Button>
                </form>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form={`rename-${agent.id}`}
                  isDisabled={busy || !renameValue.trim()}
                >
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

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
