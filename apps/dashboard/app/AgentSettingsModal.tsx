'use client';

import { Button, Input, Label, Modal, Slider, Switch, Tabs, TextField, toast } from '@heroui/react';
import { useEffect, useState } from 'react';
import { LuDices } from 'react-icons/lu';
import {
  getAgent,
  startAgent,
  stopAgent,
  updateAgent,
  MODEL_OPTIONS,
  type Agent,
} from '@/lib/gateway';
import { randomName } from '@/lib/names';
import { IntegrationsPanel } from './IntegrationsPanel';

/** Slider default when first enabling the override (a touch earlier than the
 *  ~83% claude default, so it's a meaningful change). */
const DEFAULT_PCT = 80;

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
  const [model, setModel] = useState(''); // '' = claude default
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'form' | 'restart'>('form');
  const [tab, setTab] = useState('general');

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
        setModel(a.model ?? '');
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
  // The threshold is read by claude only at launch, so it needs a restart. The
  // model switches LIVE (the gateway types `/model …` into the session), so it
  // does not — only the threshold drives the restart prompt.
  const running = agent?.status === 'running';

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await updateAgent(agentId, {
        username: name.trim(),
        autoCompactPct: nextPct,
        model: model || null,
      });
      onChanged?.();
      if (modelChanged && running) {
        const label = (MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model) || 'default';
        toast.warning(`Switching model to ${label}…`);
      }
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

                      <div className="space-y-1.5">
                        <Label className="text-sm">Model</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {MODEL_OPTIONS.map((opt) => (
                            <Button
                              key={opt.value}
                              type="button"
                              size="sm"
                              variant={model === opt.value ? 'primary' : 'tertiary'}
                              onPress={() => setModel(opt.value)}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                        <p className="text-muted text-xs">
                          The model this agent&apos;s <code>claude</code> runs — switches live.
                          &ldquo;Default&rdquo; uses claude&apos;s own default.
                        </p>
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
