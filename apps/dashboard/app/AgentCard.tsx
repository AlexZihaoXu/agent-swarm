'use client';

import { Button, Card, Dropdown, Header, Label, Modal, Separator } from '@heroui/react';
import Link from 'next/link';
import {
  LuCircleArrowUp,
  LuCirclePlay,
  LuCircleStop,
  LuEllipsisVertical,
  LuFoldVertical,
  LuFolderOpen,
  LuMonitor,
  LuPackage,
  LuSettings,
  LuTrash2,
} from 'react-icons/lu';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import {
  compactAgent,
  getUpgradeInfo,
  removeAgent,
  screenshotUrl,
  startAgent,
  stopAgent,
  upgradeAgent,
  type Agent,
  type UpgradeInfo,
} from '@/lib/gateway';
import { Identicon } from '@/lib/identicon';
import { AgentActivity, AgentStatsInline, useAgentStats } from './AgentStats';
import { AgentSettingsModal } from './AgentSettingsModal';
import { CompactingBadge } from './CompactingBadge';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { PackageModal } from './PackageModal';
import { FileExplorer } from './FileExplorer';

type Dialog = 'stop' | 'remove' | 'upgrade' | 'package' | 'settings' | 'files' | null;

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
      {/* Always mounted + opacity-faded so the first frame eases in (and refreshed
          frames don't flicker) rather than snapping from "connecting…". */}
      <img
        src={`${screenshotUrl(agentId)}?t=${ts}`}
        alt=""
        onLoad={() => setOk(true)}
        onError={() => setOk(false)}
        className={`h-full w-full object-contain transition-opacity duration-500 ease-out ${
          ok ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span
        className={`text-muted absolute inset-0 flex items-center justify-center text-xs transition-opacity duration-300 ${
          ok ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        connecting…
      </span>
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
    else if (key === 'compact') void act(() => compactAgent(agent.id));
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
          <div className="flex min-w-0 items-center gap-2">
            <Identicon
              seed={agent.avatarSeed || agent.id}
              title={agent.username || agent.id}
              className="size-6 shrink-0 rounded-md"
            />
            <h3 className="truncate font-semibold">{agent.username || agent.id}</h3>
            {/* Tap target for the actions menu — on touch there's no right-click. */}
            <button
              aria-label={`Actions for ${agent.username || agent.id}`}
              title="Actions"
              className="text-muted hover:text-foreground hover:bg-surface-secondary ml-auto shrink-0 rounded p-1"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuPos({ x: r.right, y: r.bottom });
              }}
            >
              <LuEllipsisVertical className="size-4" />
            </button>
          </div>
          <p className="text-muted truncate font-mono text-xs">{agent.id}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <AgentStatsInline stats={stats} />
          </div>
          <div className="mt-1">
            <AgentActivity
              containerStatus={agent.status}
              sessionStatus={stats?.status}
              lastActivity={stats?.lastActivity}
            />
          </div>
          {agent.desktop === false && (
            <div className="text-muted mt-1 inline-flex items-center gap-1 text-[11px]">
              <span aria-hidden className="bg-muted/60 inline-block size-1.5 rounded-full" />
              Desktop off
            </div>
          )}
          {agent.compacting && (
            <div className="mt-2">
              <CompactingBadge progress={agent.compactingProgress ?? 0} />
            </div>
          )}
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
        <Dropdown.Popover placement="bottom end" className="min-w-44">
          <Dropdown.Menu onAction={(key) => onAction(String(key))}>
            <Dropdown.Section>
              <Dropdown.Item id="open" textValue="Open">
                <span className="flex items-center justify-center">
                  <LuMonitor className="text-muted size-4 shrink-0" />
                </span>
                <Label>Open</Label>
              </Dropdown.Item>
              {running ? (
                <Dropdown.Item id="stop" textValue="Stop">
                  <span className="flex items-center justify-center">
                    <LuCircleStop className="text-muted size-4 shrink-0" />
                  </span>
                  <Label>Stop</Label>
                </Dropdown.Item>
              ) : (
                <Dropdown.Item id="start" textValue="Start">
                  <span className="flex items-center justify-center">
                    <LuCirclePlay className="text-muted size-4 shrink-0" />
                  </span>
                  <Label>Start</Label>
                </Dropdown.Item>
              )}
              {running ? (
                <Dropdown.Item id="compact" textValue="Compact">
                  <span className="flex items-center justify-center">
                    <LuFoldVertical className="text-muted size-4 shrink-0" />
                  </span>
                  <Label>Compact context</Label>
                </Dropdown.Item>
              ) : null}
              {running && upgrade?.outdated ? (
                <Dropdown.Item id="upgrade" textValue="Upgrade">
                  <span className="flex items-center justify-center">
                    <LuCircleArrowUp className="text-muted size-4 shrink-0" />
                  </span>
                  <Label>
                    Upgrade (v{upgrade.installed} → v{upgrade.latest})
                  </Label>
                </Dropdown.Item>
              ) : null}
              <Dropdown.Item id="files" textValue="Files">
                <span className="flex items-center justify-center">
                  <LuFolderOpen className="text-muted size-4 shrink-0" />
                </span>
                <Label>Files…</Label>
              </Dropdown.Item>
              <Dropdown.Item id="settings" textValue="Settings">
                <span className="flex items-center justify-center">
                  <LuSettings className="text-muted size-4 shrink-0" />
                </span>
                <Label>Settings…</Label>
              </Dropdown.Item>
              <Dropdown.Item id="package" textValue="Package">
                <span className="flex items-center justify-center">
                  <LuPackage className="text-muted size-4 shrink-0" />
                </span>
                <Label>Package…</Label>
              </Dropdown.Item>
            </Dropdown.Section>
            <Separator />
            <Dropdown.Section>
              <Header>Danger zone</Header>
              <Dropdown.Item id="remove" textValue="Remove" variant="danger">
                <span className="flex items-center justify-center">
                  <LuTrash2 className="text-danger size-4 shrink-0" />
                </span>
                <Label>Remove</Label>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <ConfirmActionDialog
        isOpen={dialog === 'stop'}
        onOpenChange={(o) => !o && setDialog(null)}
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

      <AgentSettingsModal
        agentId={agent.id}
        isOpen={dialog === 'settings'}
        onOpenChange={(o) => !o && setDialog(null)}
        onChanged={onChanged}
        taken={taken}
      />

      <FileExplorer
        agentId={agent.id}
        agentName={agent.username || agent.id}
        isOpen={dialog === 'files'}
        onOpenChange={(o) => !o && setDialog(null)}
      />

      <Modal>
        <Modal.Backdrop
          isOpen={dialog === 'upgrade'}
          onOpenChange={(o) => !o && setDialog(null)}
          isDismissable={!busy}
        >
          <Modal.Container placement="center">
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
