'use client';

import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  Spinner,
  Switch,
  TextField,
  toast,
} from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import { LuMessageSquare, LuTrash2 } from 'react-icons/lu';
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

/** Status → Chip color + label (HeroUI Chip colors: default/accent/success/warning/danger). */
const STATUS: Record<
  IntegrationStatus,
  { label: string; color: 'default' | 'accent' | 'success' | 'danger' }
> = {
  added: { label: 'Not configured', color: 'default' },
  configured: { label: 'Configured', color: 'accent' },
  'tested-ok': { label: 'Tested', color: 'success' },
  active: { label: 'Active', color: 'success' },
  error: { label: 'Error', color: 'danger' },
  disabled: { label: 'Disabled', color: 'default' },
};

const DEFAULT_RULES: DiscordRules = {
  forwardChannelIds: [],
  forwardDms: true,
  allowedUserIds: [],
  ignoreBots: true,
};

const toList = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const fromList = (a: string[]): string => a.join(', ');

/**
 * Integrations tab content (rendered inside the agent Settings modal). Connect
 * the agent to outside platforms — Discord first. Credentials are write-only:
 * the token is never returned, only a "••••1a2b" hint.
 */
export function IntegrationsPanel({ agentId, active }: { agentId: string; active: boolean }) {
  const [list, setList] = useState<Integration[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const [token, setToken] = useState('');
  const [forwardDms, setForwardDms] = useState(DEFAULT_RULES.forwardDms);
  const [ignoreBots, setIgnoreBots] = useState(DEFAULT_RULES.ignoreBots);
  const [channels, setChannels] = useState('');
  const [users, setUsers] = useState('');
  const [seeded, setSeeded] = useState(false);

  const discord = list?.find((i) => i.type === 'discord') ?? null;

  const reload = useCallback(async () => {
    try {
      setList(await listIntegrations(agentId));
    } catch {
      setList((l) => l ?? []);
    }
  }, [agentId]);

  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  // Seed the rule fields from the loaded integration once (token stays blank).
  useEffect(() => {
    if (discord && !seeded) {
      setForwardDms(discord.rules.forwardDms);
      setIgnoreBots(discord.rules.ignoreBots);
      setChannels(fromList(discord.rules.forwardChannelIds));
      setUsers(fromList(discord.rules.allowedUserIds));
      setSeeded(true);
    }
  }, [discord, seeded]);

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

  const connect = () => run(() => addIntegration(agentId, 'discord'));

  const save = () =>
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

  const test = async () => {
    setTesting(true);
    try {
      await testIntegration(agentId, 'discord');
      await reload();
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Test failed.');
    } finally {
      setTesting(false);
    }
  };

  const apply = () => run(() => applyIntegration(agentId, 'discord'), 'Discord is now active.');
  const disable = () => run(() => disableIntegration(agentId, 'discord'));
  const remove = () =>
    run(async () => {
      await removeIntegration(agentId, 'discord');
      setSeeded(false);
    });

  if (list === null) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const st = discord ? STATUS[discord.status] : null;

  return (
    <div className="space-y-5">
      {/* Connector header */}
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#5865F2]/15 text-[#5865F2]">
          <LuMessageSquare className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Discord</span>
          <span className="text-muted block text-xs">
            DMs, channels, files, screenshots, threads
          </span>
        </span>
        {st && (
          <Chip color={st.color} variant="soft" size="sm">
            <Chip.Label>{st.label}</Chip.Label>
          </Chip>
        )}
      </div>

      {!discord ? (
        <Button variant="primary" className="w-full" isDisabled={busy} onPress={connect}>
          Connect Discord
        </Button>
      ) : (
        <>
          <div>
            <TextField value={token} onChange={setToken}>
              <Label>Bot token</Label>
              <Input
                type="password"
                placeholder={
                  discord.hasCredentials ? `•••• ${discord.tokenHint ?? ''}` : 'paste bot token'
                }
              />
            </TextField>
            <p className="text-muted mt-1.5 text-xs">
              Create an app at discord.com/developers, enable the <b>Message Content</b> intent, and
              invite the bot to your server. Leave blank to keep the saved token.
            </p>
          </div>

          <div className="border-separator space-y-3 rounded-lg border p-3">
            <Switch isSelected={forwardDms} onChange={setForwardDms}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Content>
                <Label className="text-sm">Forward direct messages</Label>
                <p className="text-muted text-xs">DMs to the bot are delivered to the agent.</p>
              </Switch.Content>
            </Switch>
            <Switch isSelected={ignoreBots} onChange={setIgnoreBots}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Content>
                <Label className="text-sm">Ignore other bots</Label>
                <p className="text-muted text-xs">Skip messages authored by bots.</p>
              </Switch.Content>
            </Switch>
          </div>

          <TextField value={channels} onChange={setChannels}>
            <Label>Forwarded channels</Label>
            <Input placeholder="channel IDs, comma-separated — empty = none" />
          </TextField>
          <TextField value={users} onChange={setUsers}>
            <Label>Allowed senders</Label>
            <Input placeholder="user IDs, comma-separated — empty = anyone" />
          </TextField>

          {/* Test feedback */}
          {testing ? (
            <Alert status="accent">
              <Alert.Indicator>
                <Spinner size="sm" />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Title>Testing connection…</Alert.Title>
              </Alert.Content>
            </Alert>
          ) : discord.lastTest ? (
            <Alert status={discord.lastTest.ok ? 'success' : 'danger'}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>
                  {discord.lastTest.ok
                    ? `Connected as ${discord.lastTest.botTag}`
                    : 'Connection failed'}
                </Alert.Title>
                <Alert.Description>
                  {discord.lastTest.ok
                    ? `In ${discord.lastTest.guilds?.length ?? 0} server(s).`
                    : (discord.lastTest.detail ?? 'Unknown error.')}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="secondary" isDisabled={busy || testing} onPress={save}>
              Save
            </Button>
            <Button
              variant="secondary"
              isDisabled={busy || testing || !discord.hasCredentials}
              onPress={test}
            >
              Test
            </Button>
            {discord.status === 'active' ? (
              <Button variant="tertiary" isDisabled={busy} onPress={disable}>
                Disable
              </Button>
            ) : (
              <Button
                variant="primary"
                isDisabled={busy || !discord.hasCredentials}
                onPress={apply}
              >
                Apply
              </Button>
            )}
            <Button
              variant="tertiary"
              aria-label="Remove Discord integration"
              className="text-danger ml-auto"
              isDisabled={busy}
              onPress={remove}
            >
              <LuTrash2 className="size-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
