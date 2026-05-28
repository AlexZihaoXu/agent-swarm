'use client';

import { Button, Input, Label, Modal, Switch, TextField, toast } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { LuChevronLeft, LuMessageSquare, LuPlus, LuTrash2 } from 'react-icons/lu';
import {
  addIntegration,
  applyIntegration,
  disableIntegration,
  listIntegrations,
  removeIntegration,
  testIntegration,
  updateIntegration,
  type DiscordRules,
  type Integration,
  type IntegrationStatus,
} from '@/lib/gateway';

const STATUS: Record<IntegrationStatus, { label: string; cls: string }> = {
  added: { label: 'not configured', cls: 'text-muted' },
  configured: { label: 'configured', cls: 'text-foreground' },
  'tested-ok': { label: 'tested ✓', cls: 'text-success' },
  active: { label: 'active', cls: 'text-success' },
  error: { label: 'error', cls: 'text-danger' },
  disabled: { label: 'disabled', cls: 'text-muted' },
};

const DEFAULT_RULES: DiscordRules = {
  forwardChannelIds: [],
  forwardDms: true,
  allowedUserIds: [],
  ignoreBots: true,
};

/** Comma/whitespace-separated id list ↔ array helpers. */
const toList = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const fromList = (a: string[]): string => a.join(', ');

/**
 * Per-agent Integrations manager. Flow: list → add Discord → fill credentials +
 * rules → Test connection → Apply. Credentials are write-only (the token is
 * never returned; we show a "••••1a2b" hint instead).
 */
export function IntegrationsModal({
  agentId,
  isOpen,
  onOpenChange,
}: {
  agentId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [list, setList] = useState<Integration[]>([]);
  const [view, setView] = useState<'list' | 'discord'>('list');
  const [busy, setBusy] = useState(false);

  // Discord settings form state.
  const [token, setToken] = useState('');
  const [forwardDms, setForwardDms] = useState(DEFAULT_RULES.forwardDms);
  const [ignoreBots, setIgnoreBots] = useState(DEFAULT_RULES.ignoreBots);
  const [channels, setChannels] = useState('');
  const [users, setUsers] = useState('');

  const discord = list.find((i) => i.type === 'discord') ?? null;

  const reload = useCallback(async () => {
    try {
      setList(await listIntegrations(agentId));
    } catch {
      /* keep last */
    }
  }, [agentId]);

  useEffect(() => {
    if (!isOpen) return;
    setView('list');
    void reload();
  }, [isOpen, reload]);

  // When opening the Discord view, seed the form from current rules (token stays
  // blank — it's write-only).
  const openDiscord = (i: Integration | null) => {
    const rules = i?.rules ?? DEFAULT_RULES;
    setToken('');
    setForwardDms(rules.forwardDms);
    setIgnoreBots(rules.ignoreBots);
    setChannels(fromList(rules.forwardChannelIds));
    setUsers(fromList(rules.allowedUserIds));
    setView('discord');
  };

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      if (okMsg) toast.warning(okMsg);
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const addDiscord = () =>
    run(async () => {
      await addIntegration(agentId, 'discord');
      openDiscord(null);
    });

  // Persist credentials (only if the user typed a new token) + rules.
  const saveDiscord = () =>
    run(async () => {
      await updateIntegration(agentId, 'discord', {
        credentials: token.trim() ? { botToken: token.trim() } : undefined,
        rules: {
          forwardDms,
          ignoreBots,
          forwardChannelIds: toList(channels),
          allowedUserIds: toList(users),
        },
      });
      setToken('');
    }, 'Saved.');

  const testDiscord = () =>
    run(async () => {
      const r = await testIntegration(agentId, 'discord');
      const t = r.lastTest;
      if (t?.ok) toast.warning(`Connected as ${t.botTag} · ${t.guilds?.length ?? 0} server(s).`);
      else toast.warning(`Test failed: ${t?.detail ?? 'unknown error'}`);
    });

  const applyDiscord = () =>
    run(() => applyIntegration(agentId, 'discord'), 'Discord is now active.');
  const disableDiscord = () => run(() => disableIntegration(agentId, 'discord'));
  const removeDiscord = () =>
    run(async () => {
      await removeIntegration(agentId, 'discord');
      setView('list');
    });

  return (
    <Modal>
      <Modal.Backdrop
        isOpen={isOpen}
        onOpenChange={(o) => !o && onOpenChange(false)}
        isDismissable={!busy}
      >
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[480px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                {view === 'list' ? (
                  'Integrations'
                ) : (
                  <button
                    className="text-muted hover:text-foreground flex items-center gap-1.5"
                    onClick={() => setView('list')}
                  >
                    <LuChevronLeft className="size-4" /> Discord
                  </button>
                )}
              </Modal.Heading>
            </Modal.Header>

            {view === 'list' ? (
              <Modal.Body className="space-y-3">
                <p className="text-muted text-sm">
                  Connect this agent to outside platforms. Messages it receives are delivered to its
                  terminal; it can act and reply using its tools.
                </p>
                <button
                  onClick={() => (discord ? openDiscord(discord) : void addDiscord())}
                  disabled={busy}
                  className="border-separator hover:bg-surface flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50"
                >
                  <LuMessageSquare className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">Discord</span>
                    <span className="text-muted block text-xs">
                      {discord ? (
                        <span className={STATUS[discord.status].cls}>
                          {STATUS[discord.status].label}
                        </span>
                      ) : (
                        'Chat, DMs, files, screenshots, threads'
                      )}
                    </span>
                  </span>
                  {discord ? null : <LuPlus className="text-muted size-4 shrink-0" />}
                </button>
              </Modal.Body>
            ) : (
              <Modal.Body className="space-y-5">
                <TextField value={token} onChange={setToken}>
                  <Label>Bot token</Label>
                  <Input
                    type="password"
                    placeholder={
                      discord?.hasCredentials
                        ? `•••• ${discord.tokenHint ?? ''}`
                        : 'paste bot token'
                    }
                  />
                </TextField>

                <div className="space-y-3">
                  <Switch isSelected={forwardDms} onChange={setForwardDms}>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Switch.Content>
                      <Label className="text-sm">Forward direct messages</Label>
                    </Switch.Content>
                  </Switch>
                  <Switch isSelected={ignoreBots} onChange={setIgnoreBots}>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Switch.Content>
                      <Label className="text-sm">Ignore messages from bots</Label>
                    </Switch.Content>
                  </Switch>
                </div>

                <TextField value={channels} onChange={setChannels}>
                  <Label>Forwarded channel IDs</Label>
                  <Input placeholder="comma-separated; empty = none" />
                </TextField>
                <TextField value={users} onChange={setUsers}>
                  <Label>Allowed user IDs</Label>
                  <Input placeholder="comma-separated; empty = anyone" />
                </TextField>

                {discord?.lastTest && (
                  <p className={`text-xs ${discord.lastTest.ok ? 'text-success' : 'text-danger'}`}>
                    {discord.lastTest.ok
                      ? `Last test: ${discord.lastTest.botTag} · ${discord.lastTest.guilds?.length ?? 0} server(s)`
                      : `Last test failed: ${discord.lastTest.detail ?? 'error'}`}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" isDisabled={busy} onPress={saveDiscord}>
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    isDisabled={busy || !discord?.hasCredentials}
                    onPress={testDiscord}
                  >
                    Test connection
                  </Button>
                  {discord?.status === 'active' ? (
                    <Button variant="tertiary" isDisabled={busy} onPress={disableDiscord}>
                      Disable
                    </Button>
                  ) : (
                    <Button isDisabled={busy || !discord?.hasCredentials} onPress={applyDiscord}>
                      Apply
                    </Button>
                  )}
                  <Button
                    variant="tertiary"
                    aria-label="Remove integration"
                    isDisabled={busy}
                    onPress={removeDiscord}
                    className="ml-auto"
                  >
                    <LuTrash2 className="size-4" />
                  </Button>
                </div>
              </Modal.Body>
            )}

            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={busy}>
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
