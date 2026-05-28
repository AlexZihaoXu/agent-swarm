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
  Tooltip,
  toast,
} from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { LuInfo, LuMessageSquare, LuTrash2, LuX } from 'react-icons/lu';
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
  requireMention: true,
};

/** A field label with an info tooltip. */
function FieldLabel({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className="text-sm font-medium">{children}</span>
      <Tooltip delay={150}>
        <Tooltip.Trigger
          aria-label="More info"
          className="text-muted hover:text-foreground inline-flex cursor-help"
        >
          <LuInfo className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content showArrow className="max-w-xs">
          <Tooltip.Arrow />
          <p className="text-xs">{hint}</p>
        </Tooltip.Content>
      </Tooltip>
    </div>
  );
}

/** A list of IDs as removable chips; type + Enter (or comma) to add, Backspace to
 *  remove the last. Add/remove animate. */
function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = (raw: string) => {
    const items = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) {
      const next = [...values];
      for (const it of items) if (!next.includes(it)) next.push(it);
      onChange(next);
    }
    setDraft('');
  };
  return (
    <div className="border-separator focus-within:border-accent focus-within:ring-accent/25 flex flex-wrap items-center gap-1.5 rounded-lg border bg-transparent px-2 py-2 transition-[border-color,box-shadow] focus-within:ring-2">
      <AnimatePresence initial={false}>
        {values.map((v) => (
          <motion.span
            key={v}
            layout
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.14 }}
          >
            <Chip variant="soft" size="sm" className="gap-1">
              <Chip.Label className="font-mono text-xs">{v}</Chip.Label>
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="text-muted hover:text-foreground -mr-0.5 inline-flex"
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <LuX className="size-3" />
              </button>
            </Chip>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={values.length ? '' : placeholder}
        className="min-w-[12ch] flex-1 bg-transparent py-0.5 text-sm outline-none"
      />
    </div>
  );
}

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
  const [requireMention, setRequireMention] = useState(DEFAULT_RULES.requireMention);
  const [channels, setChannels] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
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
      setRequireMention(discord.rules.requireMention ?? true);
      setChannels(discord.rules.forwardChannelIds);
      setUsers(discord.rules.allowedUserIds);
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
          requireMention,
          forwardChannelIds: channels,
          allowedUserIds: users,
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
            <Switch isSelected={requireMention} onChange={setRequireMention}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Content>
                <Label className="text-sm">Only when mentioned</Label>
                <p className="text-muted text-xs">
                  In channels, only forward messages that @-mention the bot (DMs always come
                  through). Keeps the agent out of unrelated chatter.
                </p>
              </Switch.Content>
            </Switch>
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

          <div>
            <FieldLabel hint="Only messages posted in these channels reach the agent. In Discord turn on Settings → Advanced → Developer Mode, then right-click a channel → Copy Channel ID. Empty = no channels forwarded (DMs still work if enabled above).">
              Forwarded channels
            </FieldLabel>
            <TagInput
              values={channels}
              onChange={setChannels}
              placeholder="paste a channel ID, press Enter"
            />
          </div>

          <div>
            <FieldLabel hint="If set, only these people's messages reach the agent — everyone else is ignored. Right-click a user → Copy User ID (Developer Mode). Empty = anyone may message the agent.">
              Allowed senders
            </FieldLabel>
            <TagInput
              values={users}
              onChange={setUsers}
              placeholder="paste a user ID, press Enter"
            />
          </div>

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
