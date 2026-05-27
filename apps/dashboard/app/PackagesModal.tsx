'use client';

import { Button, Modal } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LuDownload, LuTrash2, LuUpload, LuPackage } from 'react-icons/lu';
import {
  deletePackage,
  importPackage,
  listPackages,
  packageDownloadUrl,
  uploadPackage,
  type PackageInfo,
} from '@/lib/gateway';

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
 * Manage packages: every built/uploaded .7z, with download (move to another
 * swarm), duplicate (restore into a new agent), and delete. Upload accepts a
 * .7z brought from another swarm and then lets you duplicate it here.
 */
export function PackagesModal({
  isOpen,
  onOpenChange,
  onChanged,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [pkgs, setPkgs] = useState<PackageInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listPackages()
      .then(setPkgs)
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setPkgs(null);
    refresh();
  }, [isOpen, refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    void run('upload', async () => {
      await uploadPackage(f);
      refresh();
    });
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={!busy}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[560px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Packages</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-muted text-sm">
                  Portable agent snapshots (.7z). Duplicate into a new agent, or download to move to
                  another swarm.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0 gap-1.5"
                  isDisabled={busy === 'upload'}
                  onPress={() => fileRef.current?.click()}
                >
                  <LuUpload className="size-4" />
                  {busy === 'upload' ? 'Uploading…' : 'Import .7z'}
                </Button>
                <input ref={fileRef} type="file" accept=".7z" hidden onChange={onUpload} />
              </div>

              {pkgs === null && <p className="text-muted text-sm">Loading…</p>}
              {pkgs?.length === 0 && (
                <div className="text-muted flex flex-col items-center gap-2 py-8 text-sm">
                  <LuPackage className="size-6 opacity-50" />
                  No packages yet. Package an agent, or import a .7z.
                </div>
              )}
              {pkgs && pkgs.length > 0 && (
                <ul className="border-separator divide-separator divide-y border">
                  {pkgs.map((p) => (
                    <li key={p.file} className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs">{p.file}</p>
                        <p className="text-muted text-[11px]">
                          {humanSize(p.bytes)}
                          {p.createdAt ? ` · ${new Date(p.createdAt).toLocaleString()}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="tertiary"
                        aria-label="Download"
                        render={(props) => (
                          <a
                            {...(props as React.ComponentProps<'a'>)}
                            href={packageDownloadUrl(p.file)}
                            download
                          />
                        )}
                      >
                        <LuDownload className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        isDisabled={!!busy}
                        onPress={() =>
                          void run(`dup:${p.file}`, async () => {
                            await importPackage(p.file);
                            onChanged();
                          })
                        }
                      >
                        {busy === `dup:${p.file}` ? 'Duplicating…' : 'Duplicate'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-soft"
                        aria-label="Delete package"
                        isDisabled={!!busy}
                        onPress={() =>
                          void run(`del:${p.file}`, async () => {
                            await deletePackage(p.file);
                            refresh();
                          })
                        }
                      >
                        <LuTrash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {error && <p className="text-danger mt-3 text-sm">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
