'use client';

import {
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Slider,
  Switch,
  Tabs,
  TextField,
  toast,
} from '@heroui/react';
import { useEffect, useState } from 'react';
import { LuDices, LuDownload, LuShuffle } from 'react-icons/lu';
import { Identicon, downloadIdenticon, randomSeed } from '@/lib/identicon';
import {
  getAgent,
  startAgent,
  stopAgent,
  updateAgent,
  listRoles,
  listGroups,
  listCapabilities,
  listProviders,
  type Agent,
  type Capability,
  type CapabilityInfo,
  type Provider,
  type ProviderInfo,
  type Role,
} from '@/lib/gateway';
import { randomName } from '@/lib/names';
import { IntegrationsPanel } from './IntegrationsPanel';
import { RegistrySelect } from './RolesGroups';

/** Slider default when first enabling the override (a touch earlier than the
 *  ~83% claude default, so it's a meaningful change). */
const DEFAULT_PCT = 80;

/** Sentinel for the model dropdown's "Default" option — empty string can't be
 *  a Select item id (it would render as an unkeyed list and break aria-selected
 *  state in the popover), so we map model='' ↔ this key at the boundary. */
const MODEL_DEFAULT_KEY = '__default__';

/**
 * Per-agent settings, in two tabs:
 *  - General: display name (rename, live) + auto-compact threshold
 *    (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; needs a restart to take effect, so we
 *    prompt to restart when it changes on a running agent).
 *  - Integrations: connect the agent to outside platforms (Discord first).
 */
export function AgentSettingsModal({
  agentId,
  isOpen,
  onOpenChange,
  onChanged,
  taken = [],
}: {
  agentId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  /** Display names in use across the fleet — the shuffle generator avoids them. */
  taken?: string[];
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [override, setOverride] = useState(false);
  const [pct, setPct] = useState(DEFAULT_PCT);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(''); // '' = claude default
  const [roles, setRoles] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [avatarSeed, setAvatarSeed] = useState('');
  const [permissions, setPermissions] = useState<Capability[]>([]);
  const [desktop, setDesktop] = useState(true);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [allGroups, setAllGroups] = useState<Role[]>([]);
  const [allCaps, setAllCaps] = useState<CapabilityInfo[]>([]);
  const [allProviders, setAllProviders] = useState<ProviderInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'form' | 'restart'>('form');
  const [tab, setTab] = useState('general');

  // Load the global role/group registries for the assignment selectors.
  useEffect(() => {
    if (!isOpen) return;
    void listRoles()
      .then(setAllRoles)
      .catch(() => {});
    void listGroups()
      .then(setAllGroups)
      .catch(() => {});
    void listCapabilities()
      .then(setAllCaps)
      .catch(() => {});
    void listProviders()
      .then(setAllProviders)
      .catch(() => {});
  }, [isOpen]);

  // Load fresh settings each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setPhase('form');
    setTab('general');
    let alive = true;
    getAgent(agentId)
      .then((a) => {
        if (!alive) return;
        setAgent(a);
        setName(a.username || a.id);
        const has = typeof a.autoCompactPct === 'number';
        setOverride(has);
        setPct(has ? a.autoCompactPct! : DEFAULT_PCT);
        setProvider(a.provider ?? 'anthropic');
        setModel(a.model ?? '');
        setRoles(a.roles ?? []);
        setGroups(a.groups ?? []);
        setPermissions(a.permissions ?? []);
        setDesktop(a.desktop !== false);
        setAvatarSeed(a.avatarSeed || a.id);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOpen, agentId]);

  const origPct = typeof agent?.autoCompactPct === 'number' ? agent.autoCompactPct : null;
  const nextPct = override ? Math.round(pct) : null;
  const pctChanged = nextPct !== origPct;
  const origModel = agent?.model ?? '';
  const modelChanged = model !== origModel;
  const origProvider = agent?.provider ?? 'anthropic';
  const providerChanged = provider !== origProvider;
  // The threshold is read by claude only at launch, so it needs a restart. The
  // provider switch flips ANTHROPIC_BASE_URL, which Claude Code only reads at
  // process start — so changing provider also needs a restart. The model
  // switches LIVE for Anthropic (the gateway types `/model …` into the
  // session); for opencodeGo the model lives in the proxy, also live.
  const running = agent?.status === 'running';
  const needsRestart = pctChanged || providerChanged;

  const providerModels =
    allProviders.find((p) => p.key === provider)?.models ??
    (provider === 'anthropic'
      ? [{ label: 'Default', value: '' }]
      : [{ label: 'Default', value: '' }]);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await updateAgent(agentId, {
        username: name.trim(),
        autoCompactPct: nextPct,
        provider,
        model: model || null,
        roles,
        groups,
        permissions,
        desktop,
        avatarSeed,
      });
      onChanged?.();
      if (modelChanged && !providerChanged && running) {
        const label = providerModels.find((o) => o.value === model)?.label ?? model ?? 'default';
        toast.warning(`Switching model to ${label}…`);
      }
      if (needsRestart && running) {
        setPhase('restart');
      } else {
        if (pctChanged && !providerChanged)
          toast.warning('Saved — the new threshold applies next time the agent starts.');
        onOpenChange(false);
      }
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Failed to save settings.');
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    try {
      await stopAgent(agentId);
      await startAgent(agentId);
      onChanged?.();
      onOpenChange(false);
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Restart failed — restart manually to apply.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Modal.Backdrop
        isOpen={isOpen}
        onOpenChange={(o) => !o && onOpenChange(false)}
        isDismissable={!busy}
      >
        <Modal.Container placement="center">
          <Modal.Dialog className="sm:max-w-[520px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                {phase === 'form' ? 'Agent settings' : 'Restart to apply?'}
              </Modal.Heading>
            </Modal.Header>

            {phase === 'form' ? (
              <>
                <Modal.Body>
                  <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
                    <Tabs.ListContainer>
                      <Tabs.List aria-label="Settings sections">
                        <Tabs.Tab id="general">
                          General
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="integrations">
                          Integrations
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>

                    <Tabs.Panel
                      id="general"
                      className="max-h-[60vh] space-y-5 overflow-y-auto pt-5 pr-1"
                    >
                      <div className="flex items-center gap-3">
                        <Identicon
                          seed={avatarSeed || agentId}
                          title={name || agentId}
                          className="size-14 shrink-0 rounded-lg"
                        />
                        <div className="space-y-1">
                          <Label className="text-sm">Avatar</Label>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="gap-1.5"
                              onPress={() => setAvatarSeed(randomSeed())}
                            >
                              <LuShuffle className="size-3.5" /> Shuffle
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="tertiary"
                              className="gap-1.5"
                              onPress={() =>
                                downloadIdenticon(
                                  avatarSeed || agentId,
                                  `${name || agentId}-avatar`,
                                )
                              }
                            >
                              <LuDownload className="size-3.5" /> Download
                            </Button>
                          </div>
                          <p className="text-muted text-xs">
                            A generated identicon. Shuffle for a new one; saved with the agent.
                          </p>
                        </div>
                      </div>

                      <div className="flex items-end gap-2">
                        <TextField className="flex-1" value={name} onChange={setName} isRequired>
                          <Label>Display name</Label>
                          <Input placeholder="brave-otter" />
                        </TextField>
                        <Button
                          type="button"
                          variant="secondary"
                          aria-label="Shuffle name"
                          onPress={() => {
                            const next = randomName(taken);
                            if (next) setName(next);
                            else toast.warning('All names are in use — type one manually.');
                          }}
                        >
                          <LuDices className="size-4" />
                        </Button>
                      </div>

                      <div className="space-y-2">
                        <Label className="text-sm">Provider</Label>
                        <Tabs
                          selectedKey={provider}
                          onSelectionChange={(k) => {
                            const next = String(k) as Provider;
                            if (next === provider) return;
                            setProvider(next);
                            // Reset the model when switching provider so we
                            // never carry a stale opus/glm-5/etc. from the
                            // other side's list.
                            setModel('');
                          }}
                        >
                          <Tabs.ListContainer>
                            <Tabs.List aria-label="Provider">
                              {(allProviders.length > 0
                                ? allProviders
                                : [
                                    { key: 'anthropic' as Provider, label: 'Anthropic Claude' },
                                    { key: 'opencodeGo' as Provider, label: 'OpenCode Go' },
                                  ]
                              ).map((p) => (
                                <Tabs.Tab key={p.key} id={p.key}>
                                  {p.label}
                                  <Tabs.Indicator />
                                </Tabs.Tab>
                              ))}
                            </Tabs.List>
                          </Tabs.ListContainer>
                        </Tabs>
                        <p className="text-muted text-xs">
                          {provider === 'opencodeGo'
                            ? 'Routes claude through the in-agent opencode-proxy → opencode.ai/go subscription. Set the key on the dashboard Settings page.'
                            : 'Direct to Anthropic with your Claude Code OAuth token (the default).'}
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Select
                          fullWidth
                          value={model || MODEL_DEFAULT_KEY}
                          onChange={(v) => {
                            const k = String(v ?? MODEL_DEFAULT_KEY);
                            setModel(k === MODEL_DEFAULT_KEY ? '' : k);
                          }}
                        >
                          <Label className="text-sm">Model</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              {providerModels.map((opt) => (
                                <ListBox.Item
                                  key={opt.value || MODEL_DEFAULT_KEY}
                                  id={opt.value || MODEL_DEFAULT_KEY}
                                  textValue={opt.label}
                                >
                                  {opt.label}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                        <p className="text-muted text-xs">
                          {provider === 'opencodeGo'
                            ? "Picked from OpenCode Go's catalog. Switches live on save."
                            : 'The model this agent\'s claude runs — switches live. "Default" uses claude\'s own default.'}
                        </p>
                      </div>

                      <RegistrySelect
                        label="Roles"
                        hint="No roles defined yet — create them in Settings."
                        options={allRoles}
                        value={roles}
                        onChange={setRoles}
                      />
                      <RegistrySelect
                        label="Groups"
                        hint="No groups defined yet — create them in Settings."
                        options={allGroups}
                        value={groups}
                        onChange={setGroups}
                      />

                      {allCaps.length > 0 && (
                        <div className="space-y-2">
                          <Label className="text-sm">Capabilities</Label>
                          <p className="text-muted text-xs">
                            Grant this agent direct capabilities (in addition to any from its
                            roles).
                          </p>
                          <div className="space-y-2">
                            {allCaps.map((c) => (
                              <Switch
                                key={c.key}
                                isSelected={permissions.includes(c.key)}
                                onChange={(on) =>
                                  setPermissions((prev) =>
                                    on ? [...prev, c.key] : prev.filter((p) => p !== c.key),
                                  )
                                }
                              >
                                <Switch.Control>
                                  <Switch.Thumb />
                                </Switch.Control>
                                <Switch.Content>
                                  <Label className="text-sm">{c.label}</Label>
                                  <p className="text-muted text-xs">{c.description}</p>
                                </Switch.Content>
                              </Switch>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="space-y-3">
                        <Switch isSelected={desktop} onChange={setDesktop}>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                          <Switch.Content>
                            <Label className="text-sm">Desktop (noVNC + GNOME)</Label>
                            <p className="text-muted text-xs">
                              On = the in-container desktop is reachable via the Desktop tab. Off
                              saves ~2 GB of RSS (gnome-shell, mutter, chrome) — the claude TUI
                              keeps working. Takes effect immediately on a running agent.
                            </p>
                          </Switch.Content>
                        </Switch>
                      </div>

                      <div className="space-y-3">
                        <Switch isSelected={override} onChange={setOverride}>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                          <Switch.Content>
                            <Label className="text-sm">Override auto-compact threshold</Label>
                            <p className="text-muted text-xs">
                              When context usage reaches this %, <code>claude</code> auto-compacts.
                              Off = the default (~83%).
                            </p>
                          </Switch.Content>
                        </Switch>

                        {override && (
                          <Slider
                            value={pct}
                            onChange={(v) =>
                              setPct(typeof v === 'number' ? v : (v[0] ?? DEFAULT_PCT))
                            }
                            minValue={1}
                            maxValue={100}
                            step={1}
                          >
                            <div className="flex items-center justify-between">
                              <Label className="text-sm">Compact at</Label>
                              <span className="text-sm font-medium tabular-nums">
                                {Math.round(pct)}%
                              </span>
                            </div>
                            <Slider.Track>
                              <Slider.Fill />
                              <Slider.Thumb />
                            </Slider.Track>
                          </Slider>
                        )}

                        {running && pctChanged && (
                          <p className="text-warning text-xs">
                            Changing the threshold requires restarting the agent to take effect.
                          </p>
                        )}
                      </div>
                    </Tabs.Panel>

                    <Tabs.Panel
                      id="integrations"
                      className="max-h-[60vh] overflow-y-auto pt-5 pr-1"
                    >
                      <IntegrationsPanel
                        agentId={agentId}
                        active={isOpen && tab === 'integrations'}
                      />
                    </Tabs.Panel>
                  </Tabs>
                </Modal.Body>

                <Modal.Footer>
                  {tab === 'general' ? (
                    <>
                      <Button slot="close" variant="tertiary" isDisabled={busy}>
                        Cancel
                      </Button>
                      <Button onPress={() => void save()} isDisabled={busy || !name.trim()}>
                        {busy ? 'Saving…' : 'Save'}
                      </Button>
                    </>
                  ) : (
                    <Button slot="close" variant="tertiary" isDisabled={busy}>
                      Close
                    </Button>
                  )}
                </Modal.Footer>
              </>
            ) : (
              <>
                <Modal.Body>
                  <p className="text-muted text-sm">
                    {providerChanged
                      ? 'The provider changed (ANTHROPIC_BASE_URL flips). '
                      : 'The auto-compact threshold changed. '}
                    The agent must restart (stop → start) for <code>claude</code> to pick it up. The
                    transcript is preserved and resumes via <code>--continue</code>.
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" isDisabled={busy} onPress={() => onOpenChange(false)}>
                    Later
                  </Button>
                  <Button isDisabled={busy} onPress={() => void restart()}>
                    {busy ? 'Restarting…' : 'Restart now'}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
