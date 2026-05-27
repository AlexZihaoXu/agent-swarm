'use client';

import { Button, buttonVariants, Card } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LuPackage, LuSettings } from 'react-icons/lu';
import { getImageStatus, listAgents, type Agent } from '@/lib/gateway';
import { AgentCard } from './AgentCard';
import { CreateAgentModal } from './CreateAgentModal';
import { DashboardChat } from './DashboardChat';
import { ImageBanner } from './ImageBanner';
import { PackagesModal } from './PackagesModal';
import { ThemeSwitch } from './ThemeSwitch';

export default function HomePage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [imagePresent, setImagePresent] = useState<boolean | null>(null);
  const [packagesOpen, setPackagesOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAgents(await listAgents());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh, refreshImage]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent Swarm</h1>
          <p className="text-muted text-sm">Fleet of autonomous coding agents</p>
        </div>
        <div className="flex items-center gap-3">
          <ThemeSwitch />
          <Button
            size="sm"
            variant="tertiary"
            aria-label="Packages"
            className="gap-1.5"
            onPress={() => setPackagesOpen(true)}
          >
            <LuPackage className="size-4" />
            Packages
          </Button>
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

      {agents.length === 0 && !error ? (
        <p className="text-muted text-sm">No agents yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {agents.map((a) => (
              <motion.div
                key={a.id}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <AgentCard
                  agent={a}
                  onChanged={() => void refresh()}
                  taken={agents.map((x) => x.username || x.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <DashboardChat agents={agents} />
    </main>
  );
}
