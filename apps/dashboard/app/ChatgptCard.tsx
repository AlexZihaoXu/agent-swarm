'use client';

import { Button, Card } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LuCheck, LuCopy, LuExternalLink, LuLoaderCircle, LuTriangleAlert } from 'react-icons/lu';
import {
  chatgptDisconnect,
  chatgptLoginStart,
  chatgptLoginState,
  type ChatgptLoginState,
} from '@/lib/gateway';

/** How often to check whether the operator has approved the device code. */
const POLL_MS = 3000;

function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * "Sign in with ChatGPT" for the Codex provider.
 *
 * Device-code rather than a browser callback: the gateway runs in a container
 * and the operator is usually on another machine, so a localhost callback can't
 * reach it. We show a URL and a one-time code instead, and poll for approval.
 */
export function ChatgptCard() {
  const [state, setState] = useState<ChatgptLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await chatgptLoginState());
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while a code is outstanding — no reason to hit the API otherwise.
  useEffect(() => {
    if (!state?.pending) return;
    polling.current = true;
    const t = setInterval(() => void refresh(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      polling.current = false;
      clearInterval(t);
      clearInterval(tick);
    };
  }, [state?.pending, refresh]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await chatgptLoginStart());
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await chatgptDisconnect());
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // Connected wins: if the account is linked, any lingering code is moot.
  const pending = state?.connected ? null : (state?.pending ?? null);
  const expiresIn = pending ? pending.expiresAt - now : 0;

  return (
    <Card>
      <Card.Header>
        <Card.Title>ChatGPT (Codex)</Card.Title>
        <Card.Description>
          Sign in with your ChatGPT account to let agents use your Codex subscription. Used only by
          agents whose provider is set to <span className="font-mono">chatgpt</span>. Usage shows up
          under &ldquo;other&rdquo; in your Codex dashboard.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-2 flex flex-col gap-3">
        {error && <p className="text-danger text-sm">{error}</p>}

        {state?.connected && !pending && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-success flex items-center gap-1.5">
              <LuCheck className="size-4" /> Connected
            </span>
            {state.account && <span className="text-muted font-mono text-xs">{state.account}</span>}
            <Button
              size="sm"
              variant="tertiary"
              className="ml-auto"
              isDisabled={busy}
              onPress={() => void disconnect()}
            >
              Disconnect
            </Button>
          </div>
        )}

        {pending && (
          <div className="border-separator flex flex-col gap-2 border p-3">
            <p className="text-sm">Open the link, then enter this code to authorise this swarm:</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-surface-secondary rounded px-2 py-1 font-mono text-lg tracking-[0.2em]">
                {pending.userCode}
              </code>
              <Button
                size="sm"
                variant="tertiary"
                className="gap-1.5"
                onPress={() => {
                  void navigator.clipboard?.writeText(pending.userCode).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <LuCheck className="size-4" /> : <LuCopy className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <a
                href={pending.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="text-link flex items-center gap-1.5 text-sm hover:underline"
              >
                <LuExternalLink className="size-4" />
                {pending.verificationUrl}
              </a>
            </div>
            <p className="text-muted flex items-center gap-2 text-xs">
              <LuLoaderCircle className="size-3 animate-spin" />
              Waiting for approval · code expires in {countdown(expiresIn)}
            </p>
            {/* Device codes are a known phishing vector — say so plainly. */}
            <p className="text-warning flex items-start gap-1.5 text-xs">
              <LuTriangleAlert className="mt-px size-3.5 shrink-0" />
              Never share this code. Anyone who enters it links your ChatGPT account to this swarm.
            </p>
            <Button
              size="sm"
              variant="tertiary"
              className="self-start"
              isDisabled={busy}
              onPress={() => void disconnect()}
            >
              Cancel
            </Button>
          </div>
        )}

        {!state?.connected && !pending && (
          <Button className="self-start" isDisabled={busy} onPress={() => void start()}>
            {busy ? 'Starting…' : 'Sign in with ChatGPT'}
          </Button>
        )}
      </Card.Content>
    </Card>
  );
}
