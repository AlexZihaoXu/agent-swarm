'use client';

import { Alert } from '@heroui/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getSettings } from '@/lib/gateway';

/**
 * Reminds the operator to refresh the Claude OAuth token before it expires
 * (`claude setup-token` tokens last ~1 year). Renders nothing until the token is
 * within `warnDays` of its assumed expiry. Shown on the dashboard + Settings.
 * `withLink` adds a "Settings →" affordance (omit it on the Settings page itself).
 */
export function TokenExpiryBanner({ withLink = false }: { withLink?: boolean }) {
  const [days, setDays] = useState<number | null>(null);
  const [warn, setWarn] = useState(30);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        setDays(s.daysLeft);
        setWarn(s.warnDays);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (days === null || days > warn) return null;

  const expired = days <= 0;
  const when = expired
    ? 'has expired'
    : days === 1
      ? 'expires tomorrow'
      : `expires in ${days} days`;

  return (
    <Alert status={expired ? 'danger' : 'warning'} className="mb-6">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>Claude token {when}</Alert.Title>
        <Alert.Description>
          Generate a new one on the host with <span className="font-mono">claude setup-token</span>{' '}
          and update it{' '}
          {withLink ? (
            <Link href="/settings" className="text-accent underline">
              in Settings
            </Link>
          ) : (
            'below'
          )}{' '}
          to keep agents authenticated.
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
