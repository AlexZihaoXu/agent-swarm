'use client';

import { Button, Input, Label, Modal, Slider, TextField, toast } from '@heroui/react';
import { useState } from 'react';
import { LuDices } from 'react-icons/lu';
import { createAgent } from '@/lib/gateway';
import { randomName } from '@/lib/names';

const ALL_TAKEN = 'All names are in use — type one manually.';

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
  const [cpus, setCpus] = useState(0);
  const [memGb, setMemGb] = useState(0);
  const [timezone, setTimezone] = useState('');
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
    setCpus(0);
    setMemGb(0);
    setTimezone(systemTimezone());
    setError(null);
    setOpen(true);
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

                <div className="flex flex-col gap-5 pt-1">
                  <LimitSlider
                    label="CPUs"
                    value={cpus}
                    onChange={setCpus}
                    max={16}
                    step={0.5}
                    unit="cores"
                  />
                  <LimitSlider
                    label="Max memory"
                    value={memGb}
                    onChange={setMemGb}
                    max={32}
                    step={1}
                    unit="GB"
                  />
                </div>

                <TextField name="timezone" value={timezone} onChange={setTimezone}>
                  <Label>Timezone</Label>
                  <Input placeholder="e.g. America/Toronto" />
                </TextField>

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
