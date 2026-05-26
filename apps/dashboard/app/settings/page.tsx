'use client';

import { Button, buttonVariants, Card, Input, Label, TextField } from '@heroui/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '@/lib/gateway';

type Status = { kind: 'ok' | 'warn' | 'err'; msg: string } | null;

export default function SettingsPage() {
  const [path, setPath] = useState('');
  const [fallback, setFallback] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSettings()
      .then((s) => {
        setPath(s.credentialsFile);
        setFallback(s.default);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await updateSettings(path);
      setStatus(
        r.validated === null
          ? { kind: 'warn', msg: 'Saved — could not verify the path on the host.' }
          : { kind: 'ok', msg: 'Saved and verified on the host.' },
      );
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const statusColor =
    status?.kind === 'err'
      ? 'text-danger'
      : status?.kind === 'warn'
        ? 'text-warning'
        : 'text-success';

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-center gap-3">
        <Link href="/" className={buttonVariants({ variant: 'tertiary', size: 'sm' })}>
          ← Fleet
        </Link>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>

      <Card>
        <Card.Header>
          <Card.Title>Claude credentials</Card.Title>
          <Card.Description>
            Host path to the <span className="font-mono">.credentials.json</span> the gateway mounts
            into each new agent. Resolved by the host Docker daemon, so it must be a path on the
            machine running Docker.
          </Card.Description>
        </Card.Header>
        <Card.Content className="mt-2 flex flex-col gap-3">
          <TextField value={path} onChange={setPath} name="credentialsFile">
            <Label>Credentials file path</Label>
            <Input placeholder={fallback || '/home/you/.agent-swarm/.credentials.json'} />
          </TextField>
          {fallback && (
            <p className="text-muted text-xs">
              Default: <span className="font-mono">{fallback}</span>
            </p>
          )}
          {status && <p className={`text-sm ${statusColor}`}>{status.msg}</p>}
        </Card.Content>
        <Card.Footer className="mt-4">
          <Button onPress={() => void save()} isDisabled={busy || !path.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Card.Footer>
      </Card>
    </main>
  );
}
