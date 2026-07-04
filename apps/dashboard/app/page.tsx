'use client';

import { Button, buttonVariants, Card, Spinner } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LuPackage, LuScrollText, LuSettings } from 'react-icons/lu';
import { getImageStatus, listAgents, listGroups, type Agent, type Group } from '@/lib/gateway';
import { CreateAgentModal } from './CreateAgentModal';
import { FleetView } from './FleetView';
import { DashboardChat } from './DashboardChat';
// Lazy-loaded so recharts/d3 (heavy, and below the fold) stay out of the initial
// client bundle — the dashboard shell becomes interactive without waiting on them.
const DashboardMetrics = dynamic(
  () => import('./DashboardMetrics').then((m) => m.DashboardMetrics),
  { ssr: false },
);
import { DashboardSettingsProvider } from './DashboardSettings';
import { ImageBanner } from './ImageBanner';
import { PackagesModal } from './PackagesModal';
import { ThemeSwitch } from './ThemeSwitch';
import { TokenExpiryBanner } from './TokenExpiryBanner';

/** Shared ease-out-expo curve for graceful, decelerating entrances. */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export default function HomePage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagePresent, setImagePresent] = useState<boolean | null>(null);
  const [packagesOpen, setPackagesOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAgents(await listAgents());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  // Groups change rarely — fetch once up front (and on demand via refresh) so the
  // "group by group" view has names for each section.
  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await listGroups());
    } catch {
      /* keep last-known groups */
    }
  }, []);

  const refreshImage = useCallback(async () => {
    try {
      setImagePresent((await getImageStatus()).present);
    } catch {
      /* gateway unreachable — leave as-is */
    }
  }, []);

  // Initial load + light polling so status changes show up.
  useEffect(() => {
    void refresh();
    void refreshImage();
    void refreshGroups();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh, refreshImage, refreshGroups]);

  return (
    <DashboardSettingsProvider>
      <main className="mx-auto max-w-5xl px-4 py-6 pb-28 sm:px-6 sm:py-10 sm:pb-28">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-muted text-sm">Monitor and manage your agent swarm</p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeSwitch />
            <Button
              size="sm"
              variant="tertiary"
              aria-label="Packages"
              className="gap-1.5"
              onPress={() => setPackagesOpen(true)}
            >
              <LuPackage className="size-4" />
              <span className="hidden sm:inline">Packages</span>
            </Button>
            <Link
              href="/logs"
              aria-label="Logs"
              className={`${buttonVariants({ variant: 'tertiary', size: 'sm' })} gap-1.5`}
            >
              <LuScrollText className="size-4" />
              <span className="hidden sm:inline">Logs</span>
            </Link>
            <Link
              href="/settings"
              aria-label="Settings"
              className={buttonVariants({ variant: 'tertiary', size: 'sm' })}
            >
              <LuSettings className="size-4" />
            </Link>
            <CreateAgentModal
              onCreated={() => void refresh()}
              disabled={imagePresent === false}
              taken={agents.map((a) => a.username || a.id)}
            />
          </div>
        </header>

        <TokenExpiryBanner withLink />

        <PackagesModal
          isOpen={packagesOpen}
          onOpenChange={setPackagesOpen}
          onChanged={() => void refresh()}
        />

        <AnimatePresence>
          {imagePresent === false && (
            <ImageBanner
              key="banner"
              image="agent-swarm/agent:dev"
              onBuilt={() => void refreshImage()}
            />
          )}
          {error && (
            <motion.div
              key="error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <Card className="border-danger mb-6" variant="secondary">
                <Card.Content className="text-danger text-sm">
                  Can&apos;t reach the gateway: {error}
                </Card.Content>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <DashboardMetrics />

        <AnimatePresence mode="wait">
          {!loaded ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="flex justify-center py-12"
            >
              <Spinner />
            </motion.div>
          ) : agents.length === 0 && !error ? (
            <motion.p
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="text-muted text-sm"
            >
              No agents yet. Create one to get started.
            </motion.p>
          ) : (
            <motion.div
              key="grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              <FleetView
                agents={agents}
                groups={groups}
                onChanged={() => void refresh()}
                taken={agents.map((x) => x.username || x.id)}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <DashboardChat agents={agents} />
      </main>
    </DashboardSettingsProvider>
  );
}
