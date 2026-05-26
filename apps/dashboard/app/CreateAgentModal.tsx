'use client';

import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { useState } from 'react';
import { createAgent } from '@/lib/gateway';

/** Random `workspace-XXXXXX` id, suffix from 0-9 + A-Z (mirrors the gateway). */
function defaultHostname(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `workspace-${suffix}`;
}

/**
 * "New agent" button that opens a config modal (hostname + display name) before
 * creating. Hostname becomes the agent's id/URL; username is a friendly label.
 */
export function CreateAgentModal({
  onCreated,
  disabled = false,
}: {
  onCreated: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openModal = () => {
    setHostname(defaultHostname());
    setUsername('');
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createAgent({ hostname: hostname.trim(), username: username.trim() || undefined });
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
          <Modal.Dialog className="sm:max-w-[400px]">
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
                <TextField
                  name="hostname"
                  value={hostname}
                  onChange={setHostname}
                  isRequired
                  autoFocus
                >
                  <Label>Hostname</Label>
                  <Input placeholder="workspace-A3F9K2" />
                </TextField>
                <TextField name="username" value={username} onChange={setUsername}>
                  <Label>Display name (optional)</Label>
                  <Input placeholder="e.g. research-bot" />
                </TextField>
                {error && <p className="text-danger text-sm">{error}</p>}
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                Cancel
              </Button>
              <Button type="submit" form="create-agent-form" isDisabled={busy || !hostname.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
