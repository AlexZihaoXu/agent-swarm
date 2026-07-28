'use client';

import { Button, Card, Input, Label, TextField, toast } from '@heroui/react';
import { useEffect, useState } from 'react';
import { getProviders, updateProviders, type ProvidersStatus } from '@/lib/gateway';

/** Settings card for the OpenCode Go subscription key. Mirrors the Claude
 *  authentication card's layout (presence flag + last-4 hint + paste field)
 *  but only surfaces what's relevant: there's no "from env" override and no
 *  expiry — the key is set in the dashboard or not at all. The gateway syncs
 *  the value onto every opencodeGo-provider agent's disk on save, so running
 *  agents pick it up at their next claude (re)spawn without a recreate. */
export function OpencodeGoCard() {
  const [status, setStatus] = useState<ProvidersStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => {
    void getProviders()
      .then(setStatus)
      .catch(() => {});
  };
  useEffect(reload, []);

  const save = async () => {
    setBusy(true);
    try {
      await updateProviders({ opencodeGo: { apiKey: key.trim() } });
      setKey('');
      reload();
      toast.success(key.trim() ? 'OpenCode Go key saved' : 'OpenCode Go key cleared');
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Failed to save OpenCode Go key.');
    } finally {
      setBusy(false);
    }
  };

  const hasKey = !!status?.opencodeGo?.hasKey;
  const hint = status?.opencodeGo?.keyHint;

  return (
    <Card>
      <Card.Header>
        <Card.Title>OpenCode Go</Card.Title>
        <Card.Description>
          Subscription API key (<span className="font-mono">sk-opencode-…</span>) for the OpenCode
          Go gateway — GLM, Kimi, DeepSeek, MiniMax, Qwen models routed through the in-agent{' '}
          <span className="font-mono">opencode-proxy</span>. Get one at{' '}
          <span className="font-mono">opencode.ai/go</span>. Used only by agents whose provider is
          set to <span className="font-mono">opencodeGo</span>.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-2 flex flex-col gap-3">
        <div className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span>Current:</span>
          {hasKey ? (
            <span className="text-foreground font-mono">{`•••• ${hint ?? ''}`.trim()}</span>
          ) : (
            <span className="text-warning">not configured</span>
          )}
        </div>
        <TextField value={key} onChange={setKey} name="opencodeGoKey">
          <Label>API key</Label>
          <Input type="password" placeholder="sk-opencode-…" autoComplete="off" />
        </TextField>
        <p className="text-muted text-xs">
          Leave blank and save to clear the stored key. Changes propagate to running opencodeGo
          agents on their next claude (re)spawn — no recreate needed.
        </p>
      </Card.Content>
      <Card.Footer className="mt-4">
        <Button onPress={() => void save()} isDisabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </Card.Footer>
    </Card>
  );
}
