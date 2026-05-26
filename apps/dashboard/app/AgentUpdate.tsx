'use client';

import { Button, Modal } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { LuCircleArrowUp } from 'react-icons/lu';
import { getUpgradeInfo, upgradeAgent, type UpgradeInfo } from '@/lib/gateway';

/**
 * Shows an "Upgrade" button when an agent is behind the latest migration
 * version. Applying it runs the pending migrations in order against the live
 * container and restarts the supervisor (which restarts the claude session —
 * transcript preserved). Renders nothing when up to date or unreachable.
 */
export function AgentUpdate({ agentId, onUpgraded }: { agentId: string; onUpgraded?: () => void }) {
  const [info, setInfo] = useState<UpgradeInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      setInfo(await getUpgradeInfo(agentId));
    } catch {
      setInfo(null); // unreachable (e.g. stopped)
    }
  }, [agentId]);

  useEffect(() => {
    void check();
  }, [check]);

  if (!info || !info.outdated) return null;

  const apply = async () => {
    setBusy(true);
    try {
      await upgradeAgent(agentId);
      setOpen(false);
      await check();
      onUpgraded?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Button size="sm" variant="primary" onPress={() => setOpen(true)}>
        <LuCircleArrowUp className="size-4" />
        Upgrade
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen} isDismissable={!busy}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[460px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                Upgrade agent (v{info.installed} → v{info.latest})
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-muted mb-3 text-sm">
                Runs the pending migrations against this live agent and restarts its supervisor. The{' '}
                <code>claude</code> session restarts (transcript preserved); no data is lost.
              </p>
              <ul className="border-separator divide-separator divide-y border text-sm">
                {info.pending.map((m) => (
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
              <Button onPress={() => void apply()} isDisabled={busy}>
                {busy
                  ? 'Upgrading…'
                  : `Run ${info.pending.length} migration${info.pending.length === 1 ? '' : 's'}`}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
