'use client';

import { Button, Modal } from '@heroui/react';
import Link from 'next/link';
import { LuExpand, LuX } from 'react-icons/lu';
import { DiscordClient } from '@/app/DiscordClient';

/**
 * The Discord client as a popup. Renders the same component as the dedicated
 * page, with an "open fullscreen" affordance that navigates to it — so the
 * popup is a shortcut, never a reduced variant.
 */
export function DiscordPopup({
  agentId,
  agentName,
  isOpen,
  onOpenChange,
}: {
  agentId: string;
  agentName?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
        <Modal.Container placement="center">
          {/* Big and fixed-height: a Discord layout needs the room, and a
              content-sized dialog would jump around as messages load. */}
          <Modal.Dialog className="h-[85vh] w-[95vw] max-w-[1100px] overflow-hidden p-0 sm:max-w-[1100px]">
            <div className="border-separator flex h-11 shrink-0 items-center gap-2 border-b px-3">
              <span className="truncate text-sm font-semibold">
                Discord · {agentName ?? agentId}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Link
                  href={`/agents/${encodeURIComponent(agentId)}/discord`}
                  className="text-muted hover:text-foreground hover:bg-surface-secondary flex size-8 items-center justify-center rounded transition-colors"
                  aria-label="Open fullscreen"
                  title="Open fullscreen"
                >
                  <LuExpand className="size-4" />
                </Link>
                <Button
                  size="sm"
                  variant="tertiary"
                  aria-label="Close"
                  onPress={() => onOpenChange(false)}
                >
                  <LuX className="size-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {/* Mount only while open so the poll interval doesn't run in the
                  background for every card on the dashboard. */}
              {isOpen && <DiscordClient agentId={agentId} />}
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
