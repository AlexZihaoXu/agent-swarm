'use client';

import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * Controlled confirmation dialog for disruptive actions. For irreversible ones
 * (Remove) pass `confirmWord` to require typing the name; for reversible ones
 * (Stop) omit it for a plain warning + Cancel/confirm. Open/close is driven by
 * the parent so it can be triggered from a menu.
 */
export function ConfirmActionDialog({
  isOpen,
  onOpenChange,
  confirmWord,
  action,
  title,
  description,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Require typing this exact word to enable the action (irreversible ops). */
  confirmWord?: string;
  action: string;
  title: string;
  description: ReactNode;
  onConfirm: () => Promise<void> | void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = !confirmWord || typed.trim() === confirmWord;

  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen]);

  const confirm = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={!busy}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[420px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <form
                id="confirm-action-form"
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirm();
                }}
              >
                <p className="text-muted text-sm">{description}</p>
                {confirmWord && (
                  <TextField value={typed} onChange={setTyped} autoFocus>
                    <Label>
                      Type <span className="text-foreground font-mono">{confirmWord}</span> to
                      confirm
                    </Label>
                    <Input placeholder={confirmWord} />
                  </TextField>
                )}
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="confirm-action-form"
                variant="danger"
                isDisabled={!matches || busy}
              >
                {busy ? `${action}…` : action}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
