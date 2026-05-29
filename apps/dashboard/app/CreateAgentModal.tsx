'use client';

import { Button, Input, Label, Modal, Slider, Tabs, TextField, toast } from '@heroui/react';
import { useState } from 'react';
import { LuChevronRight, LuDices } from 'react-icons/lu';
import {
  createAgent,
  getHostInfo,
  listGroups,
  listRoles,
  MODEL_OPTIONS,
  type Role,
} from '@/lib/gateway';
import { randomName } from '@/lib/names';
import { Identicon, randomSeed } from '@/lib/identicon';
import { RegistrySelect } from './RolesGroups';

const ALL_TAKEN = 'All names are in use — type one manually.';
const DEFAULT_CPUS = 2;
const DEFAULT_MEM_GB = 4;

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
  const [model, setModel] = useState(''); // '' = claude default
  const [roles, setRoles] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [allGroups, setAllGroups] = useState<Role[]>([]);
  const [avatarSeed, setAvatarSeed] = useState('');
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
    setModel('');
    setRoles([]);
    setGroups([]);
    setAvatarSeed(randomSeed());
    setError(null);
    setOpen(true);
    void listRoles()
      .then(setAllRoles)
      .catch(() => {});
    void listGroups()
      .then(setAllGroups)
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
        model: model || undefined,
        roles,
        groups,
        avatarSeed: avatarSeed || undefined,
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
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[440px]">
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
                    title="Shuffle avatar"
                    aria-label="Shuffle avatar"
                    className="focus-visible:ring-accent shrink-0 rounded-lg focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Identicon
                      seed={avatarSeed || hostname || name}
                      className="size-10 rounded-lg"
                    />
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
                  <Label className="text-sm">Model</Label>
                  <Tabs
                    selectedKey={model || 'default'}
                    onSelectionChange={(k) => setModel(String(k) === 'default' ? '' : String(k))}
                  >
                    <Tabs.ListContainer>
                      <Tabs.List aria-label="Model">
                        {MODEL_OPTIONS.map((opt) => (
                          <Tabs.Tab key={opt.value} id={opt.value || 'default'}>
                            {opt.label}
                            <Tabs.Indicator />
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs.ListContainer>
                  </Tabs>
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
