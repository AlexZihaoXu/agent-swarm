'use client';

import {
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Slider,
  Tabs,
  TextField,
  toast,
} from '@heroui/react';
import { useState } from 'react';
import { LuChevronRight, LuDices, LuRefreshCw } from 'react-icons/lu';
import {
  createAgent,
  EFFORT_OPTIONS,
  listVolumes,
  getHostInfo,
  listGroups,
  listProviders,
  listRoles,
  type Provider,
  type ProviderInfo,
  type Role,
  type SharedVolume,
} from '@/lib/gateway';
import { randomName } from '@/lib/names';
import { Identicon, randomSeed } from '@/lib/identicon';
import { RegistrySelect } from './RolesGroups';

const ALL_TAKEN = 'All names are in use — type one manually.';
const DEFAULT_CPUS = 2;
const DEFAULT_MEM_GB = 4;
/** Sentinel for the model dropdown's "Default" option — see AgentSettingsModal. */
const MODEL_DEFAULT_KEY = '__default__';

/** A resource-cap slider where 0 means "unlimited". */
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
      className="flex-1"
      value={value}
      onChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)}
      minValue={0}
      maxValue={max}
      step={step}
    >
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
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

/** Random `workspace-XXXXXX` id, suffix from 0-9 + A-Z (mirrors the gateway). */
function defaultHostname(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `workspace-${suffix}`;
}

/** The agent's system timezone (the browser's), e.g. "America/Toronto". */
function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * "New agent" button that opens a config modal before creating: a mandatory
 * display name (random, with a shuffle button), the hostname (its id/URL), and
 * optional CPU/memory caps + timezone (defaults to the system's).
 */
export function CreateAgentModal({
  onCreated,
  disabled = false,
  taken = [],
}: {
  onCreated: () => void;
  disabled?: boolean;
  /** Display names already in use by other agents — the generator avoids them. */
  taken?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState('');
  const [name, setName] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [cpus, setCpus] = useState(DEFAULT_CPUS);
  const [memGb, setMemGb] = useState(DEFAULT_MEM_GB);
  const [maxCpus, setMaxCpus] = useState(8);
  const [maxMemGb, setMaxMemGb] = useState(16);
  const [timezone, setTimezone] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(''); // '' = claude default
  const [effort, setEffort] = useState(''); // '' = claude default
  const [roles, setRoles] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [allGroups, setAllGroups] = useState<Role[]>([]);
  const [allProviders, setAllProviders] = useState<ProviderInfo[]>([]);
  const [avatarSeed, setAvatarSeed] = useState('');
  const [volumes, setVolumes] = useState<string[]>([]);
  const [allVolumes, setAllVolumes] = useState<SharedVolume[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shuffle = () => {
    const next = randomName(taken);
    if (next) setName(next);
    else toast.warning(ALL_TAKEN);
  };

  const openModal = () => {
    setHostname(defaultHostname());
    const next = randomName(taken);
    setName(next ?? '');
    if (!next) toast.warning(ALL_TAKEN);
    setAdvanced(false);
    setCpus(DEFAULT_CPUS);
    setMemGb(DEFAULT_MEM_GB);
    setTimezone(systemTimezone());
    setProvider('anthropic');
    setModel('');
    setEffort('');
    setRoles([]);
    setGroups([]);
    setAvatarSeed(randomSeed());
    setVolumes([]);
    setError(null);
    setOpen(true);
    void listVolumes()
      .then(setAllVolumes)
      .catch(() => {});
    void listRoles()
      .then(setAllRoles)
      .catch(() => {});
    void listGroups()
      .then(setAllGroups)
      .catch(() => {});
    void listProviders()
      .then(setAllProviders)
      .catch(() => {});
    // Cap the sliders at the host's real hardware (and pull the defaults down
    // if the machine has less than 2 cores / 4 GB).
    getHostInfo()
      .then((h) => {
        const mc = Math.max(1, Math.floor(h.cpus || 8));
        const mm = Math.max(0.25, Math.floor((h.memoryMb || 16384) / 256) * 0.25);
        setMaxCpus(mc);
        setMaxMemGb(mm);
        setCpus((c) => Math.min(c, mc));
        setMemGb((m) => Math.min(m, mm));
      })
      .catch(() => {});
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createAgent({
        hostname: hostname.trim(),
        username: name.trim(),
        cpus: cpus > 0 ? cpus : undefined,
        memoryMb: memGb > 0 ? Math.round(memGb * 1024) : undefined,
        timezone: timezone.trim() || undefined,
        provider,
        model: model || undefined,
        effort: effort || undefined,
        roles,
        groups,
        avatarSeed: avatarSeed || undefined,
        volumes: volumes.length > 0 ? volumes : undefined,
      });
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Button onPress={openModal} isDisabled={disabled}>
        New agent
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container placement="center" scroll="inside">
          {/* Cap the height at 85dvh so a tall (advanced-settings-expanded) form
              scrolls INSIDE the body — header + footer (Create/Cancel) stay
              pinned — instead of pushing the footer off-screen. Wider so the
              two sliders can sit side-by-side and trim the height. */}
          <Modal.Dialog className="max-h-[85dvh] sm:max-w-[520px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>New agent</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <form
                id="create-agent-form"
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => setAvatarSeed(randomSeed())}
                    title="Click to generate a new avatar"
                    aria-label="Generate a new avatar"
                    className="group focus-visible:ring-accent relative shrink-0 cursor-pointer overflow-hidden rounded-lg focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Identicon
                      seed={avatarSeed || hostname || name}
                      className="size-10 rounded-lg transition group-hover:brightness-75"
                    />
                    {/* Hover affordance: darken + a regenerate indicator. */}
                    <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
                      <LuRefreshCw className="size-4 text-white drop-shadow" />
                    </span>
                  </button>
                  <TextField
                    className="flex-1"
                    name="name"
                    value={name}
                    onChange={setName}
                    isRequired
                    autoFocus
                  >
                    <Label>Name</Label>
                    <Input placeholder="brave-otter" />
                  </TextField>
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label="Shuffle name"
                    onPress={shuffle}
                  >
                    <LuDices className="size-4" />
                  </Button>
                </div>

                <TextField name="hostname" value={hostname} onChange={setHostname} isRequired>
                  <Label>Hostname</Label>
                  <Input placeholder="workspace-A3F9K2" />
                </TextField>

                <div className="space-y-2">
                  <Label className="text-sm">Provider</Label>
                  <Tabs
                    selectedKey={provider}
                    onSelectionChange={(k) => {
                      const next = String(k) as Provider;
                      if (next === provider) return;
                      setProvider(next);
                      setModel(''); // reset → default for the new provider's list
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
                        {(
                          allProviders.find((p) => p.key === provider)?.models ?? [
                            { label: 'Default', value: '' },
                          ]
                        ).map((opt) => (
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
                </div>

                <div className="space-y-2">
                  <Select
                    fullWidth
                    value={effort || MODEL_DEFAULT_KEY}
                    onChange={(v) => {
                      const k = String(v ?? MODEL_DEFAULT_KEY);
                      setEffort(k === MODEL_DEFAULT_KEY ? '' : k);
                    }}
                  >
                    <Label className="text-sm">Effort</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {EFFORT_OPTIONS.map((opt) => (
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
                  {effort === 'ultracode' && (
                    <p className="text-muted text-xs">
                      Max effort + multi-agent Workflow orchestration. Best on agents sized up
                      beyond the 2-core / 4 GB default.
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setAdvanced((a) => !a)}
                  className="text-muted hover:text-foreground -mb-1 flex items-center gap-1.5 self-start text-sm"
                >
                  <LuChevronRight
                    className={`size-4 transition-transform ${advanced ? 'rotate-90' : ''}`}
                  />
                  Advanced settings
                </button>

                {advanced && (
                  <div className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
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
                    </div>
                    <TextField name="timezone" value={timezone} onChange={setTimezone}>
                      <Label>Timezone</Label>
                      <Input placeholder="e.g. America/Toronto" />
                    </TextField>
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
                    {allVolumes.length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-sm">Shared volumes</Label>
                        <p className="text-muted text-xs">
                          Mounted at <code>~/Shared/&lt;name&gt;</code>, shared with every other
                          attached agent.
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {allVolumes.map((v) => {
                            const on = volumes.includes(v.name);
                            return (
                              <Button
                                key={v.name}
                                size="sm"
                                variant={on ? 'primary' : 'tertiary'}
                                className="font-mono"
                                onPress={() =>
                                  setVolumes((prev) =>
                                    on ? prev.filter((x) => x !== v.name) : [...prev, v.name],
                                  )
                                }
                              >
                                {v.name}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {error && <p className="text-danger text-sm">{error}</p>}
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                Cancel
              </Button>
              <Button
                type="submit"
                form="create-agent-form"
                isDisabled={busy || !hostname.trim() || !name.trim()}
              >
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
