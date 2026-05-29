'use client';

import { Button, buttonVariants, Card, Input, Label, TextField, toast } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LuChevronLeft, LuLogOut } from 'react-icons/lu';
import {
  getSettings,
  updateSettings,
  changePassword,
  logout,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listCapabilities,
  type CapabilityInfo,
  type Settings,
} from '@/lib/gateway';
import { TokenExpiryBanner } from '@/app/TokenExpiryBanner';
import { RegistryCard } from '@/app/RolesGroups';

type Status = { kind: 'ok' | 'warn' | 'err'; msg: string } | null;

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([]);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const doLogout = async () => {
    try {
      await logout();
    } finally {
      window.location.href = '/login';
    }
  };

  const savePassword = async () => {
    if (newPw.length < 8) return toast.warning('New password must be at least 8 characters.');
    setPwBusy(true);
    try {
      await changePassword(curPw, newPw);
      setCurPw('');
      setNewPw('');
      toast.success('Password updated.');
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Failed to update password.');
    } finally {
      setPwBusy(false);
    }
  };

  const load = () =>
    getSettings()
      .then(setSettings)
      .catch(() => {});

  useEffect(() => {
    void load();
    void listCapabilities()
      .then(setCapabilities)
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await updateSettings(token.trim());
      setToken('');
      await load();
      setStatus(
        r.hasToken
          ? {
              kind: 'ok',
              msg: 'Saved. New agents will use this token; restart existing agents to apply.',
            }
          : { kind: 'warn', msg: 'Token cleared.' },
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
    <motion.main
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto max-w-2xl px-6 py-10"
    >
      <header className="mb-8 flex items-center gap-3">
        <Link href="/" className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}>
          <LuChevronLeft className="size-4" />
          Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>

      <TokenExpiryBanner />

      <Card>
        <Card.Header>
          <Card.Title>Claude authentication</Card.Title>
          <Card.Description>
            Agents authenticate with a Claude Code OAuth token, billed to your subscription.
            Generate one on the host with <span className="font-mono">claude setup-token</span> and
            paste it here. It&apos;s injected into each agent as{' '}
            <span className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</span>.
          </Card.Description>
        </Card.Header>
        <Card.Content className="mt-2 flex flex-col gap-3">
          <div className="text-muted text-sm">
            Current:{' '}
            {settings?.hasToken ? (
              <span className="text-foreground font-mono">•••• {settings.tokenHint}</span>
            ) : (
              <span className="text-warning">not configured</span>
            )}
            {settings?.hasToken && settings.fromEnv && (
              <span className="text-muted/70"> (from environment)</span>
            )}
          </div>
          <TextField value={token} onChange={setToken} name="oauthToken">
            <Label>OAuth token</Label>
            <Input type="password" placeholder="sk-ant-oat01-…" autoComplete="off" />
          </TextField>
          <p className="text-muted text-xs">
            Leave blank and save to clear the stored token (falls back to the environment).
          </p>
          {status && <p className={`text-sm ${statusColor}`}>{status.msg}</p>}
        </Card.Content>
        <Card.Footer className="mt-4">
          <Button onPress={() => void save()} isDisabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Card.Footer>
      </Card>

      <div className="mt-6">
        <RegistryCard
          title="Roles"
          description="Named responsibilities agents read to understand what they do. Assign them per agent in its settings."
          noun="role"
          list={listRoles}
          onCreate={createRole}
          onUpdate={updateRole}
          onDelete={deleteRole}
          capabilities={capabilities}
        />
      </div>
      <div className="mt-6">
        <RegistryCard
          title="Groups"
          description="Scope swarm communication — agents can only message / share files with peers in a shared group."
          noun="group"
          list={listGroups}
          onCreate={createGroup}
          onUpdate={updateGroup}
          onDelete={deleteGroup}
        />
      </div>

      <div className="mt-6">
        <Card>
          <Card.Header>
            <Card.Title>Account</Card.Title>
            <Card.Description>
              Your operator login for this dashboard. Change the password or sign out.
            </Card.Description>
          </Card.Header>
          <Card.Content className="mt-2 flex flex-col gap-3">
            <TextField value={curPw} onChange={setCurPw}>
              <Label>Current password</Label>
              <Input type="password" autoComplete="current-password" placeholder="••••••••" />
            </TextField>
            <TextField value={newPw} onChange={setNewPw}>
              <Label>New password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="at least 8 characters"
              />
            </TextField>
          </Card.Content>
          <Card.Footer className="mt-4 flex items-center justify-between">
            <Button
              onPress={() => void savePassword()}
              isDisabled={pwBusy || !curPw || newPw.length < 8}
            >
              {pwBusy ? 'Updating…' : 'Update password'}
            </Button>
            <Button variant="tertiary" className="gap-1.5" onPress={() => void doLogout()}>
              <LuLogOut className="size-4" /> Sign out
            </Button>
          </Card.Footer>
        </Card>
      </div>
    </motion.main>
  );
}
