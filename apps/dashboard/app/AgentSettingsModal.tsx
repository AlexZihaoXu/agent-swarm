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
  TextArea,
  TextField,
  Tooltip,
  toast,
} from '@heroui/react';
import { useEffect, useState } from 'react';
import { LuCircleHelp, LuDices, LuDownload, LuMaximize2, LuShuffle } from 'react-icons/lu';
import { LargeEditorModal } from './LargeEditorModal';
import { Identicon, downloadIdenticon, randomSeed } from '@/lib/identicon';
import {
  getAgent,
  getHostInfo,
  startAgent,
  stopAgent,
  updateAgent,
  listRoles,
  listGroups,
  listCapabilities,
  listProviders,
  listVolumes,
  recreateAgent,
  type Agent,
  type Capability,
  type CapabilityInfo,
  type Provider,
  type ProviderInfo,
  type Role,
  type SharedVolume,
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

/** A resource-cap slider where 0 means "unlimited" (mirrors CreateAgentModal). */
function LimitSlider({
  label,
  value,
  onChange,
  max,
  step,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  max: number;
  step: number;
  unit: string;
}) {
  return (
    <Slider
      value={value}
      onChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)}
      minValue={0}
      maxValue={max}
      step={step}
    >
      <div className="flex items-center justify-between">
        <Label className="text-sm">{label}</Label>
        <span className="text-muted text-xs tabular-nums">
          {value === 0 ? 'unlimited' : `${value} ${unit}`}
        </span>
      </div>
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  );
}

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
  const [guidance, setGuidance] = useState(''); // this agent's own ~/.claude/CLAUDE.md
  const [guidanceBig, setGuidanceBig] = useState(false);
  const [cpus, setCpus] = useState(0); // 0 = unlimited
  const [memGb, setMemGb] = useState(0); // 0 = unlimited
  const [maxCpus, setMaxCpus] = useState(8);
  const [maxMemGb, setMaxMemGb] = useState(16);
  const [timezone, setTimezone] = useState(''); // '' = inherit (UTC)
  const [override, setOverride] = useState(false);
  const [pct, setPct] = useState(DEFAULT_PCT);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(''); // '' = claude default
  const [roles, setRoles] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [avatarSeed, setAvatarSeed] = useState('');
  const [permissions, setPermissions] = useState<Capability[]>([]);
  const [desktop, setDesktop] = useState(true);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [allVolumes, setAllVolumes] = useState<SharedVolume[]>([]);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [allGroups, setAllGroups] = useState<Role[]>([]);
  const [allCaps, setAllCaps] = useState<CapabilityInfo[]>([]);
  const [allProviders, setAllProviders] = useState<ProviderInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'form' | 'restart' | 'rebuild'>('form');
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
    void listVolumes()
      .then(setAllVolumes)
      .catch(() => {});
    // Cap the resource sliders at the host's real hardware (mirrors create).
    void getHostInfo()
      .then((h) => {
        setMaxCpus(Math.max(1, Math.floor(h.cpus || 8)));
        setMaxMemGb(Math.max(0.25, Math.floor((h.memoryMb || 16384) / 256) * 0.25));
      })
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
        setGuidance(a.guidance ?? '');
        setCpus(a.cpus ?? 0);
        setMemGb(a.memoryMb ? a.memoryMb / 1024 : 0);
        setTimezone(a.timezone ?? '');
        const has = typeof a.autoCompactPct === 'number';
        setOverride(has);
        setPct(has ? a.autoCompactPct! : DEFAULT_PCT);
        setProvider(a.provider ?? 'anthropic');
        setModel(a.model ?? '');
        setRoles(a.roles ?? []);
        setGroups(a.groups ?? []);
        setPermissions(a.permissions ?? []);
        setDesktop(a.desktop !== false);
        setVolumes(a.volumes ?? []);
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
  const origGuidance = agent?.guidance ?? '';
  const guidanceChanged = guidance !== origGuidance;
  // The threshold is read by claude only at launch, so it needs a restart. The
  // provider switch flips ANTHROPIC_BASE_URL, which Claude Code only reads at
  // process start — so changing provider also needs a restart. Guidance lands in
  // ~/.claude/CLAUDE.md, read by claude at session start — also restart-to-apply.
  // The model switches LIVE for Anthropic (the gateway types `/model …` into the
  // session); for opencodeGo the model lives in the proxy, also live.
  const running = agent?.status === 'running';
  const needsRestart = pctChanged || providerChanged || guidanceChanged;
  const origVolumes = JSON.stringify([...(agent?.volumes ?? [])].sort());
  const volumesChanged = JSON.stringify([...volumes].sort()) !== origVolumes;
  // CPU/memory caps bind on the container's HostConfig at create, so a change
  // only lands on a rebuild (recreate) — same as volumes.
  const origCpus = agent?.cpus ?? 0;
  const origMemGb = agent?.memoryMb ? agent.memoryMb / 1024 : 0;
  const resourcesChanged = cpus !== origCpus || memGb !== origMemGb;
  // Timezone is the container's TZ env, also fixed at create → rebuild to apply.
  const timezoneChanged = timezone.trim() !== (agent?.timezone ?? '');

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
        guidance: guidance.trim() || null,
        cpus: cpus > 0 ? cpus : null,
        memoryMb: memGb > 0 ? Math.round(memGb * 1024) : null,
        timezone: timezone.trim() || null,
        autoCompactPct: nextPct,
        provider,
        model: model || null,
        roles,
        groups,
        permissions,
        desktop,
        avatarSeed,
        volumes,
      });
      onChanged?.();
      if (modelChanged && !providerChanged && running) {
        const label = providerModels.find((o) => o.value === model)?.label ?? model ?? 'default';
        toast.warning(`Switching model to ${label}…`);
      }
      // A rebuild (recreate) re-reads the threshold/provider too, so it takes
      // priority when a create-time setting (resources/timezone/volumes) changed.
      if ((volumesChanged || resourcesChanged || timezoneChanged) && running) {
        setPhase('rebuild');
      } else if (needsRestart && running) {
        setPhase('restart');
      } else {
        if (pctChanged && !providerChanged)
          toast.warning('Saved — the new threshold applies next time the agent starts.');
        if (guidanceChanged && !running)
          toast.success('Saved — guidance applies when the agent starts.');
        if (volumesChanged && !running)
          toast.success('Saved — volumes mount when the agent starts.');
        if ((resourcesChanged || timezoneChanged) && !running)
          toast.success('Saved — CPU/memory/timezone apply on the next rebuild.');
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

  /** Container rebuild (rm + create) — required for volume attach/detach since
   *  binds are fixed at container create. Home disk + transcript persist. */
  const rebuild = async () => {
    setBusy(true);
    try {
      await recreateAgent(agentId);
      onChanged?.();
      onOpenChange(false);
    } catch (e) {
      toast.warning(
        e instanceof Error ? e.message : 'Rebuild failed — recreate manually to apply.',
      );
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
                {phase === 'form'
                  ? 'Agent settings'
                  : phase === 'restart'
                    ? 'Restart to apply?'
                    : 'Rebuild to apply?'}
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
                        <Tabs.Tab id="access">
                          Access
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="resources">
                          Resources
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

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">Guidance (CLAUDE.md)</span>
                          <Button
                            size="sm"
                            variant="tertiary"
                            className="gap-1.5"
                            onPress={() => setGuidanceBig(true)}
                          >
                            <LuMaximize2 className="size-3.5" />
                            Expand
                          </Button>
                        </div>
                        <TextField
                          value={guidance}
                          onChange={setGuidance}
                          aria-label="Guidance (CLAUDE.md)"
                        >
                          <TextArea
                            rows={5}
                            className="resize-y font-mono text-xs leading-relaxed"
                            placeholder={
                              'Instructions for THIS agent only — e.g.\nYou are the release manager; never merge without two approvals.'
                            }
                          />
                        </TextField>
                        <LargeEditorModal
                          isOpen={guidanceBig}
                          onOpenChange={setGuidanceBig}
                          title="Guidance (CLAUDE.md)"
                          value={guidance}
                          markdown
                          filename="CLAUDE.md"
                          onSave={setGuidance}
                        />
                        <p className="text-muted text-xs">
                          Written to this agent&apos;s own <code>~/.claude/CLAUDE.md</code> — its
                          user-level memory, separate from every other agent. Read by{' '}
                          <code>claude</code> in addition to its roles.{' '}
                          {running && guidanceChanged
                            ? 'Requires a restart to take effect.'
                            : 'Applies on the next restart.'}
                        </p>
                      </div>
                    </Tabs.Panel>

                    <Tabs.Panel
                      id="access"
                      className="max-h-[60vh] space-y-5 overflow-y-auto pt-5 pr-1"
                    >
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
                              <div key={c.key} className="flex items-start gap-2">
                                <Switch
                                  className="flex-1"
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
                                {c.mcpHelp && (
                                  <Tooltip>
                                    <Tooltip.Trigger
                                      aria-label={`Help for ${c.label}`}
                                      className="text-muted hover:text-foreground focus-visible:text-foreground mt-0.5 shrink-0 rounded-full p-1 focus-visible:outline-none"
                                    >
                                      <LuCircleHelp className="size-4" aria-hidden />
                                    </Tooltip.Trigger>
                                    <Tooltip.Content
                                      showArrow
                                      placement="left"
                                      className="max-w-[360px]"
                                    >
                                      <Tooltip.Arrow />
                                      <div className="space-y-1 px-1 py-1.5">
                                        <div className="text-xs font-semibold">
                                          What this lets the agent do
                                        </div>
                                        <p className="text-xs leading-relaxed">{c.mcpHelp}</p>
                                      </div>
                                    </Tooltip.Content>
                                  </Tooltip>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </Tabs.Panel>

                    <Tabs.Panel
                      id="resources"
                      className="max-h-[60vh] space-y-5 overflow-y-auto pt-5 pr-1"
                    >
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <Label className="text-sm">Resource limits</Label>
                          <p className="text-muted text-xs">
                            Hard CPU and memory caps for the container. 0 = unlimited. These are
                            fixed when the container is created, so a change rebuilds the agent to
                            apply.
                          </p>
                        </div>
                        <LimitSlider
                          label="CPUs"
                          value={cpus}
                          onChange={setCpus}
                          max={maxCpus}
                          step={1}
                          unit="cores"
                        />
                        <LimitSlider
                          label="Max memory"
                          value={memGb}
                          onChange={setMemGb}
                          max={maxMemGb}
                          step={0.25}
                          unit="GB"
                        />
                        {running && resourcesChanged && (
                          <p className="text-warning text-xs">
                            Changing CPU/memory rebuilds the agent (recreate) to take effect — the
                            transcript is preserved.
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <TextField value={timezone} onChange={setTimezone}>
                          <Label className="text-sm">Timezone</Label>
                          <Input placeholder="e.g. America/Toronto (blank = UTC)" />
                        </TextField>
                        <p className="text-muted text-xs">
                          IANA timezone for this agent (its <code>TZ</code> — used by{' '}
                          <code>claude</code> and CLI tools for timestamps). Fixed at container
                          create, so a change rebuilds the agent to apply.
                          {running && timezoneChanged ? ' Requires a rebuild to take effect.' : ''}
                        </p>
                      </div>

                      {allVolumes.length > 0 && (
                        <div className="space-y-2">
                          <Label className="text-sm">Shared volumes</Label>
                          <p className="text-muted text-xs">
                            Mounted at <code>~/Shared/&lt;name&gt;</code> — files are shared with
                            every other attached agent. Changes apply on the next rebuild.
                          </p>
                          <div className="space-y-2">
                            {allVolumes.map((v) => (
                              <Switch
                                key={v.name}
                                isSelected={volumes.includes(v.name)}
                                onChange={(on) =>
                                  setVolumes((prev) =>
                                    on ? [...prev, v.name] : prev.filter((x) => x !== v.name),
                                  )
                                }
                              >
                                <Switch.Control>
                                  <Switch.Thumb />
                                </Switch.Control>
                                <Switch.Content>
                                  <Label className="text-sm font-mono">{v.name}</Label>
                                  <p className="text-muted text-xs">
                                    {v.usedMb !== null ? `${v.usedMb} / ` : ''}
                                    {v.sizeMb} MB
                                    {v.attachedTo.length > 0
                                      ? ` · shared with ${
                                          v.attachedTo
                                            .filter((a) => a.id !== agentId)
                                            .map((a) => a.name)
                                            .join(', ') || 'no one else yet'
                                        }`
                                      : ''}
                                  </p>
                                </Switch.Content>
                              </Switch>
                            ))}
                          </div>
                        </div>
                      )}

                      {allVolumes.length === 0 && (
                        <p className="text-muted text-xs">
                          No shared volumes exist yet — create them on the dashboard Settings page,
                          then attach here.
                        </p>
                      )}

                      <div className="border-separator space-y-3 border-t pt-5">
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

                      <div className="border-separator space-y-3 border-t pt-5">
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
                  {tab !== 'integrations' ? (
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
            ) : phase === 'restart' ? (
              <>
                <Modal.Body>
                  <p className="text-muted text-sm">
                    You changed{' '}
                    {[
                      providerChanged && 'the provider (ANTHROPIC_BASE_URL)',
                      pctChanged && 'the auto-compact threshold',
                      guidanceChanged && 'the guidance (CLAUDE.md)',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    . The agent must restart (stop → start) for <code>claude</code> to pick it up.
                    The transcript is preserved and resumes via <code>--continue</code>.
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
            ) : (
              <>
                <Modal.Body>
                  <p className="text-muted text-sm">
                    You changed{' '}
                    {[
                      resourcesChanged && 'the CPU/memory caps',
                      timezoneChanged && 'the timezone',
                      volumesChanged && 'volume attachments',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    . These bind when the container is created, so the agent&apos;s container must
                    be rebuilt (same disk, fresh container) to apply. The transcript is preserved
                    and resumes via <code>--continue</code>.
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" isDisabled={busy} onPress={() => onOpenChange(false)}>
                    Later
                  </Button>
                  <Button isDisabled={busy} onPress={() => void rebuild()}>
                    {busy ? 'Rebuilding…' : 'Rebuild now'}
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
