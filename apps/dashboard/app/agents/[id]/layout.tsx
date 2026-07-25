'use client';

import { Button, buttonVariants, Tabs } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { use, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import {
  LuChevronLeft,
  LuFolderOpen,
  LuMessagesSquare,
  LuMonitor,
  LuSettings,
  LuTerminal,
} from 'react-icons/lu';
import { AgentSettingsModal } from '@/app/AgentSettingsModal';
import { AgentStatsBar, AgentStatsProvider } from '@/app/AgentStats';
import { FileExplorer } from '@/app/FileExplorer';
import { agentFilesBase, listIntegrations } from '@/lib/gateway';
import { ChatWidget } from './ChatWidget';
import { DesktopLockButton, DesktopLockProvider } from './DesktopLock';

// HeroUI's Tab `render` hands generic DOM props; Link wants anchor props. They
// line up at runtime (Tab renders an <a>), so narrow at this single boundary.
type LinkProps = ComponentProps<typeof Link>;
const asLink = (props: object) => <Link {...(props as unknown as LinkProps)} />;

/**
 * Persistent shell for an agent: a "Dashboard" back-link plus a Terminal/Desktop tab
 * switcher. The active tab is derived from the route segment (not client state)
 * so each view has its own URL — refreshing /agents/:id/desktop stays on the
 * desktop. The layout itself doesn't remount on tab change, so the HeroUI tab
 * indicator animates smoothly between the two.
 */
export default function AgentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const segment = useSelectedLayoutSegment() ?? 'desktop';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  // The Discord tab only exists for agents that actually have a bot configured.
  const [hasDiscord, setHasDiscord] = useState(false);

  useEffect(() => {
    void listIntegrations(id)
      .then((ints) => setHasDiscord(ints.some((i) => i.type === 'discord' && i.hasCredentials)))
      .catch(() => setHasDiscord(false));
  }, [id]);

  return (
    <motion.div
      className="flex h-screen flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <AgentStatsProvider agentId={id}>
        <DesktopLockProvider>
          <header className="border-separator flex flex-wrap items-center gap-x-3 gap-y-2 border-b py-2 pr-4 pl-4">
            <Link
              href="/"
              className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}
            >
              <LuChevronLeft className="size-4" />
              Dashboard
            </Link>
            <span className="hidden text-sm font-semibold sm:inline">{id}</span>
            <Tabs selectedKey={segment} className="ml-2">
              <Tabs.ListContainer>
                <Tabs.List aria-label="Agent views">
                  <Tabs.Tab id="desktop" href={`/agents/${id}/desktop`} render={asLink}>
                    <span className="flex items-center gap-1.5">
                      <LuMonitor className="size-4" />
                      Desktop
                    </span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="terminal" href={`/agents/${id}/terminal`} render={asLink}>
                    <span className="flex items-center gap-1.5">
                      <LuTerminal className="size-4" />
                      Terminal
                    </span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  {hasDiscord ? (
                    <Tabs.Tab id="discord" href={`/agents/${id}/discord`} render={asLink}>
                      <span className="flex items-center gap-1.5">
                        <LuMessagesSquare className="size-4" />
                        Discord
                      </span>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  ) : null}
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
            <Button
              size="sm"
              variant="tertiary"
              className="gap-1.5"
              aria-label="Files"
              onPress={() => setFilesOpen(true)}
            >
              <LuFolderOpen className="size-4" />
              <span className="hidden sm:inline">Files</span>
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              aria-label="Agent settings"
              onPress={() => setSettingsOpen(true)}
            >
              <LuSettings className="size-4" />
            </Button>
            <div className="ml-auto hidden min-w-0 md:flex">
              <AgentStatsBar agentId={id} />
            </div>
            {segment === 'desktop' && (
              <div className="ml-auto md:ml-0">
                <DesktopLockButton />
              </div>
            )}
          </header>

          <div className="min-h-0 flex-1">{children}</div>
        </DesktopLockProvider>
        <AgentSettingsModal agentId={id} isOpen={settingsOpen} onOpenChange={setSettingsOpen} />
        <FileExplorer
          apiBase={agentFilesBase(id)}
          title={id}
          copyPathRoot="/home/agent"
          defaultPath="Desktop"
          isOpen={filesOpen}
          onOpenChange={setFilesOpen}
        />
        <ChatWidget agentId={id} />
      </AgentStatsProvider>
    </motion.div>
  );
}
