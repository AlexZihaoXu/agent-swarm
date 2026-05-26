'use client';

import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { useState, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'outline' | 'ghost' | 'danger';

/**
 * A button whose action runs only after the user types the agent name to
 * confirm — used for destructive/disruptive operations (Stop, Remove).
 */
export function ConfirmActionButton({
  confirmWord,
  action,
  title,
  description,
  variant = 'tertiary',
  isDisabled = false,
  children,
  onConfirm,
}: {
  confirmWord: string;
  action: string;
  title: string;
  description: ReactNode;
  variant?: Variant;
  isDisabled?: boolean;
  children: ReactNode;
  onConfirm: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === confirmWord;

  const openModal = () => {
    setTyped('');
    setOpen(true);
  };

  const confirm = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Button size="sm" variant={variant} isDisabled={isDisabled} onPress={openModal}>
        {children}
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen} isDismissable={!busy}>
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
                <TextField value={typed} onChange={setTyped} autoFocus>
                  <Label>
                    Type <span className="text-foreground font-mono">{confirmWord}</span> to confirm
                  </Label>
                  <Input placeholder={confirmWord} />
                </TextField>
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
