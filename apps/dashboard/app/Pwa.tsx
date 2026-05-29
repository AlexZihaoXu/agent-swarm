'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { LuWifiOff } from 'react-icons/lu';

/**
 * PWA glue: registers the service worker (so the app is installable + boots
 * offline) and shows a popup when the device loses its network connection —
 * since the dashboard can't do anything useful without the gateway.
 */
export function Pwa() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
          role="alertdialog"
          aria-label="Offline"
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="border-separator bg-surface w-full max-w-sm rounded-2xl border p-6 text-center shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
          >
            <div className="bg-warning/15 text-warning mx-auto mb-3 flex size-11 items-center justify-center rounded-xl">
              <LuWifiOff className="size-5" />
            </div>
            <h2 className="text-lg font-semibold">You&apos;re offline</h2>
            <p className="text-muted mt-1.5 text-sm">
              Reconnect to the network to manage your swarm. This will clear automatically once
              you&apos;re back online.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
