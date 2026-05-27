'use client';

import { Button, Modal } from '@heroui/react';
import { useEffect, useState } from 'react';
import { LuCheck, LuDownload, LuFolder, LuFile } from 'react-icons/lu';
import {
  getAgentPaths,
  importPackage,
  packageAgent,
  packageDownloadUrl,
  type AgentPath,
  type PackageInfo,
} from '@/lib/gateway';

const DEFAULTS = new Set(['Desktop', 'Documents', '.claude', '.config']);

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const u = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${u[i]}`;
}

/**
 * Package an agent's persistent disk: pick which folders to include, then create
 * a .7z (the agent is stopped first so files are at rest). The result can be
 * downloaded (to move to another swarm) or duplicated into a new agent.
 */
export function PackageModal({
  agentId,
  isOpen,
  onOpenChange,
  onChanged,
}: {
  agentId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [paths, setPaths] = useState<AgentPath[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PackageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setResult(null);
    setError(null);
    setPaths(null);
    getAgentPaths(agentId)
      .then((p) => {
        setPaths(p);
        setPicked(new Set(p.filter((x) => DEFAULTS.has(x.name)).map((x) => x.name)));
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [isOpen, agentId]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const s = new Set(prev);
      if (s.has(name)) s.delete(name);
      else s.add(name);
      return s;
    });

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await packageAgent(agentId, [...picked]));
      onChanged(); // agent is now stopped
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      await importPackage(result.file);
      onChanged();
      onOpenChange(false);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={!busy}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[480px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Package {agentId}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {!result ? (
                <>
                  <p className="text-muted mb-3 text-sm">
                    The agent is <strong>stopped</strong> while packaging (so files are at rest),
                    then the selected folders are archived to a <code>.7z</code> you can download or
                    duplicate.
                  </p>
                  <div className="border-separator max-h-64 space-y-1 overflow-auto border p-1">
                    {paths === null && <p className="text-muted p-2 text-sm">Reading disk…</p>}
                    {paths?.length === 0 && (
                      <p className="text-muted p-2 text-sm">No persistent disk for this agent.</p>
                    )}
                    {paths?.map((p) => {
                      const on = picked.has(p.name);
                      return (
                        <button
                          key={p.name}
                          onClick={() => toggle(p.name)}
                          className={`flex w-full items-center gap-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-left text-sm transition-colors ${
                            on
                              ? 'border-accent bg-accent/10'
                              : 'border-separator hover:bg-surface-secondary'
                          }`}
                        >
                          <span
                            className={`flex size-4 shrink-0 items-center justify-center rounded-[var(--radius)] border ${
                              on
                                ? 'border-accent bg-accent text-accent-foreground'
                                : 'border-separator'
                            }`}
                          >
                            {on && <LuCheck className="size-3" />}
                          </span>
                          {p.dir ? (
                            <LuFolder className="text-muted size-4 shrink-0" />
                          ) : (
                            <LuFile className="text-muted size-4 shrink-0" />
                          )}
                          <span className="truncate font-mono text-xs">{p.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="space-y-3 text-sm">
                  <p className="text-success font-medium">Packaged ✓</p>
                  <p className="text-muted">
                    <span className="font-mono">{result.file}</span> · {humanSize(result.bytes)}
                  </p>
                  <p className="text-muted text-xs">
                    Download it to move to another swarm, or duplicate it into a new agent here.
                  </p>
                </div>
              )}
              {error && <p className="text-danger mt-3 text-sm">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              {!result ? (
                <>
                  <Button slot="close" variant="tertiary" isDisabled={busy}>
                    Cancel
                  </Button>
                  <Button isDisabled={busy || picked.size === 0} onPress={() => void create()}>
                    {busy ? 'Packaging…' : `Package ${picked.size || ''}`}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    className="gap-1.5"
                    render={(props) => (
                      <a
                        {...(props as React.ComponentProps<'a'>)}
                        href={packageDownloadUrl(result.file)}
                        download
                      />
                    )}
                  >
                    <LuDownload className="size-4" />
                    Download
                  </Button>
                  <Button isDisabled={busy} onPress={() => void duplicate()}>
                    {busy ? 'Duplicating…' : 'Duplicate to new agent'}
                  </Button>
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
