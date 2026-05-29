'use client';

import { Button, Card, Input, Label, TextField } from '@heroui/react';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { LuLock, LuShieldCheck } from 'react-icons/lu';
import { getAuthStatus, login, setupLogin } from '@/lib/gateway';
import { PasswordField } from '@/app/PasswordField';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Operator login. On first run (no credentials yet) it shows a "create your
 * login" setup form; afterwards, a normal sign-in. On success the gateway sets
 * an HttpOnly session cookie and we hard-navigate to the dashboard.
 */
export default function LoginPage() {
  const [mode, setMode] = useState<'loading' | 'setup' | 'login'>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuthStatus()
      .then((s) => {
        if (s.authed) {
          window.location.href = '/';
          return;
        }
        setMode(s.configured ? 'login' : 'setup');
      })
      .catch(() => setMode('login'));
  }, []);

  const submit = async () => {
    setError(null);
    if (mode === 'setup') {
      if (password.length < 8) return setError('Password must be at least 8 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }
    setBusy(true);
    try {
      if (mode === 'setup') await setupLogin(username.trim(), password);
      else await login(username.trim(), password);
      window.location.href = '/';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const setup = mode === 'setup';

  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="w-full max-w-sm"
      >
        <Card>
          <Card.Header>
            <div className="bg-accent/15 text-accent mb-2 flex size-10 items-center justify-center rounded-xl">
              {setup ? <LuShieldCheck className="size-5" /> : <LuLock className="size-5" />}
            </div>
            <Card.Title>{setup ? 'Create your login' : 'Sign in'}</Card.Title>
            <Card.Description>
              {setup
                ? 'First run — set an operator username and password for this swarm. Stored as a salted hash.'
                : 'Enter your operator credentials to manage the swarm.'}
            </Card.Description>
          </Card.Header>
          <Card.Content className="mt-2">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void submit();
              }}
            >
              <TextField value={username} onChange={setUsername} isRequired autoFocus>
                <Label>Username</Label>
                <Input autoComplete="username" placeholder="admin" />
              </TextField>
              <PasswordField
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete={setup ? 'new-password' : 'current-password'}
                placeholder={setup ? 'at least 8 characters' : '••••••••'}
              />
              {setup && (
                <PasswordField
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  autoComplete="new-password"
                />
              )}
              {error && <p className="text-danger text-sm">{error}</p>}
              <Button
                type="submit"
                className="mt-1"
                isDisabled={busy || mode === 'loading' || !username.trim() || !password}
              >
                {busy ? 'Please wait…' : setup ? 'Create login' : 'Sign in'}
              </Button>
            </form>
          </Card.Content>
        </Card>
      </motion.div>
    </main>
  );
}
