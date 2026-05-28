'use client';

import { Button, Input, Label, Modal, Slider, Switch, TextField, toast } from '@heroui/react';
import { useEffect, useState } from 'react';
import { LuDices } from 'react-icons/lu';
import { getAgent, startAgent, stopAgent, updateAgent, type Agent } from '@/lib/gateway';
import { randomName } from '@/lib/names';

/** Slider default when first enabling the override (a touch earlier than the
 *  ~83% claude default, so it's a meaningful change). */
const DEFAULT_PCT = 80;

/**
 * Per-agent settings: display name (rename) + the auto-compact threshold
 * (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE). The name applies live; changing the
 * threshold needs the agent to restart (stop → start) so the supervisor
 * relaunches `claude` with the new env — so we prompt to restart when it
 * changes on a running agent.
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
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'form' | 'restart'>('form');

  // Load fresh settings each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setPhase('form');
    let alive = true;
    getAgent(agentId)
      .then((a) => {
        if (!alive) return;
        setAgent(a);
        setName(a.username || a.id);
        const has = typeof a.autoCompactPct === 'number';
        setOverride(has);
        setPct(has ? a.autoCompactPct! : DEFAULT_PCT);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOpen, agentId]);

  const origPct = typeof agent?.autoCompactPct === 'number' ? agent.autoCompactPct : null;
  const nextPct = override ? Math.round(pct) : null;
  const pctChanged = nextPct !== origPct;
  const running = agent?.status === 'running';

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await updateAgent(agentId, { username: name.trim(), autoCompactPct: nextPct });
      onChanged?.();
      if (pctChanged && running) {
        setPhase('restart');
      } else {
        if (pctChanged)
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
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[440px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                {phase === 'form' ? 'Agent settings' : 'Restart to apply?'}
              </Modal.Heading>
            </Modal.Header>

            {phase === 'form' ? (
              <>
                <Modal.Body className="space-y-5">
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

                  <div className="space-y-3">
                    <Switch isSelected={override} onChange={setOverride}>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Switch.Content>
                        <Label className="text-sm">Override auto-compact threshold</Label>
                        <p className="text-muted text-xs">
                          When context usage reaches this %, <code>claude</code> auto-compacts. Off
                          = the default (~83%).
                        </p>
                      </Switch.Content>
                    </Switch>

                    {override && (
                      <Slider
                        value={pct}
                        onChange={(v) => setPct(typeof v === 'number' ? v : (v[0] ?? DEFAULT_PCT))}
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
                </Modal.Body>
                <Modal.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={busy}>
                    Cancel
                  </Button>
                  <Button onPress={() => void save()} isDisabled={busy || !name.trim()}>
                    {busy ? 'Saving…' : 'Save'}
                  </Button>
                </Modal.Footer>
              </>
            ) : (
              <>
                <Modal.Body>
                  <p className="text-muted text-sm">
                    The auto-compact threshold changed. The agent must restart (stop → start) for{' '}
                    <code>claude</code> to pick it up. The transcript is preserved and resumes via{' '}
                    <code>--continue</code>.
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
