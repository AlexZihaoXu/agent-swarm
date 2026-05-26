import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server bundle for the production container image.
  output: 'standalone',
  // The monorepo root, so standalone tracing picks up workspace deps correctly.
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  // In dev the dashboard is reached through the gateway (origin :8080), which
  // proxies /_next/* and the HMR socket back here — allow that origin.
  allowedDevOrigins: ['localhost:8080', '127.0.0.1:8080'],
};

export default nextConfig;
