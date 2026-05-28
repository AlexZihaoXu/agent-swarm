'use client';

import { buttonVariants, Tabs } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { use, type ComponentProps, type ReactNode } from 'react';
import { LuChevronLeft, LuMonitor, LuTerminal } from 'react-icons/lu';
import { AgentStatsBar } from '@/app/AgentStats';
import { ChatWidget } from './ChatWidget';
import { DesktopLockButton, DesktopLockProvider } from './DesktopLock';

// HeroUI's Tab `render` hands generic DOM props; Link wants anchor props. They
// line up at runtime (Tab renders an <a>), so narrow at this single boundary.
type LinkProps = ComponentProps<typeof Link>;
const asLink = (props: object) => <Link {...(props as unknown as LinkProps)} />;

/**
 * Persistent shell for an agent: a "← Fleet" link plus a Terminal/Desktop tab
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

  return (
    <motion.div
      className="flex h-screen flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <DesktopLockProvider>
        <header className="border-separator flex items-center gap-3 border-b py-2 pr-4 pl-4">
          <Link
            href="/"
            className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}
          >
            <LuChevronLeft className="size-4" />
            Dashboard
          </Link>
          <span className="text-sm font-semibold">{id}</span>
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
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <AgentStatsBar agentId={id} />
          {segment === 'desktop' && <DesktopLockButton />}
        </header>

        <div className="min-h-0 flex-1">{children}</div>
      </DesktopLockProvider>
      <ChatWidget agentId={id} />
    </motion.div>
  );
}
