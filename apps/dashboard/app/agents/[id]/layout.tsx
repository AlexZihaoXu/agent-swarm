'use client';

import { buttonVariants, Tabs } from '@heroui/react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { use, type ComponentProps, type ReactNode } from 'react';

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
  const segment = useSelectedLayoutSegment() ?? 'terminal';

  return (
    <motion.div
      className="flex h-screen flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <header className="border-separator flex items-center gap-3 border-b px-4 py-2">
        <Link href="/" className={buttonVariants({ variant: 'tertiary', size: 'sm' })}>
          ← Fleet
        </Link>
        <span className="text-sm font-semibold">{id}</span>
        <Tabs selectedKey={segment} className="ml-2">
          <Tabs.ListContainer>
            <Tabs.List aria-label="Agent views">
              <Tabs.Tab id="desktop" href={`/agents/${id}/desktop`} render={asLink}>
                Desktop
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="terminal" href={`/agents/${id}/terminal`} render={asLink}>
                Terminal
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </motion.div>
  );
}
