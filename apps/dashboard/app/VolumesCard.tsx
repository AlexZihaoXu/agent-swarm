'use client';

import { Button, Card, Input, Label, TextField, Tooltip } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { LuHardDrive, LuPlus, LuTrash2, LuTriangleAlert } from 'react-icons/lu';
import {
  createVolume,
  deleteVolume,
  listVolumes,
  VOLUME_MAX_MB,
  VOLUME_MIN_MB,
  type SharedVolume,
} from '@/lib/gateway';

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** Size presets for the create form — covers the practical range without a
 *  free-form number field that invites typos. */
const SIZE_PRESETS = [256, 512, 1024, 2048, 4096, 8192];

/**
 * Shared-volume management as a Settings section: loop-image ext4 filesystems
 * mounted into attached agents at ~/Shared/<name>. The fixed filesystem size
 * is the hard cap — agents writing past it get ENOSPC. Attach/detach lives in
 * each agent's settings (and the create-agent form); this card is
 * create / inspect / delete.
 */
export function VolumesCard() {
  const [vols, setVols] = useState<SharedVolume[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sizeMb, setSizeMb] = useState(1024);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listVolumes()
      .then(setVols)
      .catch((e) => setError(String((e as Error)?.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const validName = /^[a-z0-9][a-z0-9-]{0,30}$/.test(name);

  const onCreate = () =>
    run('create', async () => {
      await createVolume(name, sizeMb);
      setName('');
    });

  return (
    <Card>
      <Card.Header>
        <Card.Title>Shared volumes</Card.Title>
        <Card.Description>
          Size-capped filesystems mounted into attached agents at{' '}
          <span className="font-mono">~/Shared/&lt;name&gt;</span> — the same files in every
          attached agent. Attach from an agent&apos;s settings (or when creating one); attach/detach
          applies on the agent&apos;s next rebuild.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-2 flex flex-col gap-4">
        {/* Create form */}
        <div className="border-separator flex flex-wrap items-end gap-2 border p-3">
          <TextField
            className="min-w-40 flex-1"
            value={name}
            onChange={setName}
            isInvalid={name.length > 0 && !validName}
          >
            <Label>Name</Label>
            <Input placeholder="team-workspace" />
          </TextField>
          <div className="flex flex-col gap-1">
            <Label className="text-sm">Size</Label>
            <div className="flex flex-wrap gap-1">
              {SIZE_PRESETS.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={sizeMb === s ? 'primary' : 'tertiary'}
                  className="px-2 tabular-nums"
                  onPress={() => setSizeMb(s)}
                >
                  {fmtMb(s)}
                </Button>
              ))}
            </div>
          </div>
          <Button
            size="sm"
            className="gap-1.5"
            isDisabled={!validName || busy === 'create'}
            onPress={onCreate}
          >
            <LuPlus className="size-4" />
            {busy === 'create' ? 'Creating…' : 'Create'}
          </Button>
          <p className="text-muted/80 w-full text-[11px]">
            Lowercase letters, digits, hyphens. {fmtMb(VOLUME_MIN_MB)}–{fmtMb(VOLUME_MAX_MB)}.
          </p>
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        {vols === null && <p className="text-muted text-sm">Loading…</p>}
        {vols?.length === 0 && (
          <div className="text-muted flex flex-col items-center gap-2 py-6 text-sm">
            <LuHardDrive className="size-6 opacity-50" />
            No shared volumes yet.
          </div>
        )}
        {vols && vols.length > 0 && (
          <ul className="border-separator divide-separator divide-y border">
            {vols.map((v) => {
              const pct =
                v.usedMb !== null ? Math.min(100, Math.round((v.usedMb / v.sizeMb) * 100)) : 0;
              return (
                <li key={v.name} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <LuHardDrive className="text-muted size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm">{v.name}</span>
                    {!v.mounted && (
                      <Tooltip>
                        <Tooltip.Trigger className="text-warning flex items-center gap-1 text-[11px]">
                          <LuTriangleAlert className="size-3.5" /> unmounted
                        </Tooltip.Trigger>
                        <Tooltip.Content showArrow className="max-w-[280px]">
                          <Tooltip.Arrow />
                          <p className="px-1 py-1.5 text-xs">
                            The loop filesystem isn&apos;t mounted (or hasn&apos;t propagated yet).
                            The gateway re-mounts volumes at boot; if this persists, restart the
                            dashboard stack.
                          </p>
                        </Tooltip.Content>
                      </Tooltip>
                    )}
                    <span className="text-muted text-xs tabular-nums">
                      {v.usedMb !== null ? `${fmtMb(v.usedMb)} / ` : ''}
                      {fmtMb(v.sizeMb)}
                    </span>
                    {confirmDelete === v.name ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="danger"
                          isDisabled={busy === `del:${v.name}`}
                          onPress={() => {
                            setConfirmDelete(null);
                            void run(`del:${v.name}`, () => deleteVolume(v.name));
                          }}
                        >
                          Delete
                        </Button>
                        <Button size="sm" variant="tertiary" onPress={() => setConfirmDelete(null)}>
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="tertiary"
                        aria-label={`Delete ${v.name}`}
                        isDisabled={v.attachedTo.length > 0 || busy !== null}
                        onPress={() => setConfirmDelete(v.name)}
                      >
                        <LuTrash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  {v.mounted && v.usedMb !== null && (
                    <div className="bg-surface-secondary mt-2 h-1.5 w-full overflow-hidden rounded-full">
                      <div
                        className={`h-full rounded-full transition-all ${
                          pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success'
                        }`}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                  )}
                  <div className="text-muted mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                    {v.attachedTo.length === 0 ? (
                      <span>not attached to any agent</span>
                    ) : (
                      <>
                        <span>attached:</span>
                        {v.attachedTo.map((a) => (
                          <span
                            key={a.id}
                            className="bg-surface-secondary rounded px-1.5 py-0.5 font-mono"
                          >
                            {a.name}
                          </span>
                        ))}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card.Content>
    </Card>
  );
}
