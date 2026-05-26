'use client';

import { Button, Modal, Spinner } from '@heroui/react';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { buildImage, getImageStatus } from '@/lib/gateway';

type Phase = 'idle' | 'building' | 'done' | 'failed';

/**
 * Shown when the agent image isn't built yet. Doesn't build silently — it
 * prompts; clicking Build streams the daemon's progress live and, on success,
 * notifies the parent so the banner clears and agent creation unlocks.
 */
export function ImageBanner({ image, onBuilt }: { image: string; onBuilt: () => void }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const start = async () => {
    setOpen(true);
    setPhase('building');
    setLog('');
    try {
      await buildImage((chunk) => setLog((prev) => prev + chunk));
      const status = await getImageStatus();
      setPhase(status.present ? 'done' : 'failed');
      if (status.present) onBuilt();
    } catch (e) {
      setLog((prev) => prev + `\n${e instanceof Error ? e.message : String(e)}\n`);
      setPhase('failed');
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
      <div className="border-warning bg-warning-soft text-warning-soft-foreground flex items-center gap-4 border px-4 py-3">
        <div className="flex-1">
          <p className="text-sm font-semibold">Agent image not built</p>
          <p className="text-xs opacity-80">
            <span className="font-mono">{image}</span> isn&apos;t present yet — build it before
            creating agents.
          </p>
        </div>
        <Button size="sm" onPress={start} isDisabled={phase === 'building'}>
          {phase === 'building' ? 'Building…' : 'Build image'}
        </Button>
      </div>

      <Modal>
        <Modal.Backdrop isOpen={open} onOpenChange={setOpen} isDismissable={phase !== 'building'}>
          <Modal.Container>
            <Modal.Dialog className="sm:max-w-[640px]">
              {phase !== 'building' && <Modal.CloseTrigger />}
              <Modal.Header>
                <Modal.Heading>
                  <span className="flex items-center gap-2">
                    {phase === 'building' && <Spinner size="sm" />}
                    {phase === 'building' && 'Building agent image…'}
                    {phase === 'done' && '✓ Agent image built'}
                    {phase === 'failed' && '✗ Build failed'}
                  </span>
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <pre
                  ref={logRef}
                  className="bg-surface-secondary text-foreground h-80 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                >
                  {log || 'Starting build…'}
                </pre>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={phase === 'building'}>
                  {phase === 'done' ? 'Done' : 'Close'}
                </Button>
                {phase === 'failed' && <Button onPress={start}>Retry</Button>}
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </motion.div>
  );
}
