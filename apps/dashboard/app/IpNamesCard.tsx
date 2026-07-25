'use client';

import { Button, Card, Input, Label, TextField } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { LuGlobe, LuPlus, LuTrash2 } from 'react-icons/lu';
import { listIpNames, normalizeIp, updateIpNames, type IpNameEntry } from '@/lib/gateway';

/** Permissive on purpose — a dotted quad or anything hex-and-colons. The
 *  gateway is the authority; this only greys out the Add button on typos. */
function looksLikeIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-f:]{2,}$/.test(ip);
}

/**
 * Friendly names for known client IPs, as a Settings section. Not a security
 * control — nothing is allowed or blocked by it. It exists so the Auth attempts
 * view reads "home" for an address you recognize, which is what makes a login
 * from somewhere unfamiliar visually obvious.
 */
export function IpNamesCard() {
  const [rows, setRows] = useState<IpNameEntry[] | null>(null);
  const [ip, setIp] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listIpNames()
      .then(setRows)
      .catch((e) => setError(String((e as Error)?.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Add / rename / remove all funnel through one whole-list save, matching the
  // PUT-replaces-the-map shape of the endpoint.
  const save = async (next: IpNameEntry[]) => {
    setBusy(true);
    setError(null);
    const prev = rows;
    setRows(next); // optimistic — reverted below if the gateway rejects it
    try {
      await updateIpNames(next);
    } catch (e) {
      setRows(prev);
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const valid = looksLikeIp(ip) && name.trim().length > 0;

  const onAdd = async () => {
    if (!valid) return;
    const entry = { ip: normalizeIp(ip), name: name.trim() };
    // Last-one-wins on a duplicate, same as the gateway's validator.
    const next = [...(rows ?? []).filter((r) => normalizeIp(r.ip) !== entry.ip), entry];
    setIp('');
    setName('');
    await save(next);
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Known IPs</Card.Title>
        <Card.Description>
          Give addresses you recognize a friendly name. Named IPs show as{' '}
          <span className="font-mono">operator@home</span> in{' '}
          <span className="font-mono">Auth attempts</span> and the log viewer; anything unnamed is
          flagged as an unknown location.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-2 flex flex-col gap-4">
        {/* Add form */}
        <div className="border-separator flex flex-wrap items-end gap-2 border p-3">
          <TextField
            className="min-w-40 flex-1"
            value={ip}
            onChange={setIp}
            isInvalid={ip.length > 0 && !looksLikeIp(ip)}
          >
            <Label>IP address</Label>
            <Input placeholder="203.0.113.7" />
          </TextField>
          <TextField className="min-w-40 flex-1" value={name} onChange={setName}>
            <Label>Name</Label>
            <Input placeholder="home" />
          </TextField>
          <Button size="sm" className="gap-1.5" isDisabled={!valid || busy} onPress={onAdd}>
            <LuPlus className="size-4" />
            {busy ? 'Saving…' : 'Add'}
          </Button>
          <p className="text-muted/80 w-full text-[11px]">
            IPv4 or IPv6. A port or an <span className="font-mono">::ffff:</span> prefix is stripped
            automatically, so the name still matches however the address arrives.
          </p>
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        {rows === null && <p className="text-muted text-sm">Loading…</p>}
        {rows?.length === 0 && (
          <div className="text-muted flex flex-col items-center gap-2 py-6 text-sm">
            <LuGlobe className="size-6 opacity-50" />
            No named IPs yet.
          </div>
        )}
        {rows && rows.length > 0 && (
          <ul className="border-separator divide-separator divide-y border">
            {rows.map((r, i) => (
              <li key={r.ip} className="flex items-center gap-2 px-3 py-2.5">
                <LuGlobe className="text-muted size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{r.ip}</span>
                <TextField
                  className="w-40"
                  aria-label={`Name for ${r.ip}`}
                  value={r.name}
                  onChange={(v) => setRows(rows.map((x, j) => (i === j ? { ...x, name: v } : x)))}
                >
                  <Input
                    className="h-8 text-sm"
                    // Commit on blur/Enter rather than per keystroke — one PUT
                    // per edit instead of one per character.
                    onBlur={() => void save(rows.filter((x) => x.name.trim()))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </TextField>
                <Button
                  size="sm"
                  variant="tertiary"
                  aria-label={`Remove ${r.ip}`}
                  isDisabled={busy}
                  onPress={() => void save(rows.filter((_, j) => j !== i))}
                >
                  <LuTrash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card.Content>
    </Card>
  );
}
