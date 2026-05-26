'use client';

import { Button, Modal, Spinner } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { LuFile, LuFolder } from 'react-icons/lu';
import { listHostDir, type DirListing } from '@/lib/gateway';

/**
 * Host file browser. The dashboard can't read the host filesystem directly, so
 * it asks the gateway to list each directory (via a read-only probe mount).
 * Picking a file returns its absolute host path.
 */
export function FilePickerModal({
  isOpen,
  onOpenChange,
  startPath,
  onPick,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  startPath?: string;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await listHostDir(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void load(startPath);
  }, [isOpen, startPath, load]);

  const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[520px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Pick credentials file</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-muted mb-2 font-mono text-xs break-all">
                {listing?.path ?? startPath ?? '…'}
              </p>
              <div className="border-separator h-72 overflow-auto border">
                {loading && (
                  <div className="flex h-full items-center justify-center">
                    <Spinner size="sm" />
                  </div>
                )}
                {error && <p className="text-danger p-3 text-sm">{error}</p>}
                {!loading && !error && listing && (
                  <ul className="text-sm">
                    {listing.parent && (
                      <li>
                        <button
                          className="hover:bg-surface-secondary flex w-full items-center gap-2 px-3 py-1.5 text-left"
                          onClick={() => void load(listing.parent!)}
                        >
                          <LuFolder className="size-4 opacity-60" /> ..
                        </button>
                      </li>
                    )}
                    {listing.entries.map((e) => (
                      <li key={e.name}>
                        <button
                          className="hover:bg-surface-secondary flex w-full items-center gap-2 px-3 py-1.5 text-left"
                          onClick={() =>
                            e.dir
                              ? void load(join(listing.path, e.name))
                              : (onPick(join(listing.path, e.name)), onOpenChange(false))
                          }
                        >
                          {e.dir ? (
                            <LuFolder className="size-4 opacity-60" />
                          ) : (
                            <LuFile className="size-4 opacity-60" />
                          )}
                          <span className={e.dir ? '' : 'text-foreground'}>{e.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                Cancel
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
