// Request gate predicates for server.ts, kept free of side effects so they can
// be unit-tested (server.ts starts the listener on import).

const production = process.env.NODE_ENV === 'production';

/** Static assets the login screen (and the PWA install) need before a session
 *  exists. Read-only (GET/HEAD): nothing here should ever accept a body. */
const PUBLIC_ASSETS = new Set([
  '/login',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon.svg',
]);

/**
 * Requests reachable without a session: the auth API, CORS preflights to the
 * API (answered by applyCors, never proxied), and GET/HEAD for the login page
 * and its static assets. Everything else, including every other Next.js route
 * (`/_next/image`, server actions, data routes) and the agent proxy, is gated:
 * the less of Next.js an anonymous caller can reach, the less any future
 * Next.js advisory matters here.
 */
export function isPublicRequest(method: string, pathname: string, dev = !production): boolean {
  if (pathname.startsWith('/api/auth/')) return true;
  if (method === 'OPTIONS') return pathname.startsWith('/api/');
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (PUBLIC_ASSETS.has(pathname) || pathname.startsWith('/_next/static/')) return true;
  // Next dev internals (HMR, overlays) only exist under `next dev`.
  return dev && (pathname.startsWith('/_next/') || pathname.startsWith('/__next'));
}
