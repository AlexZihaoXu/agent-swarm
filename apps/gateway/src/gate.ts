// Request gate predicates for server.ts, kept free of side effects so they can
// be unit-tested (server.ts starts the listener on import).
import type { IncomingHttpHeaders } from 'node:http';

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

/** The dashboard's own host as the browser sees it: the Host header, or the
 *  forwarded host when a trusted proxy rewrote Host. */
function hostMatches(
  origin: string,
  headers: IncomingHttpHeaders,
  trustForwarded: boolean,
): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === headers.host) return true;
  const fwd = headers['x-forwarded-host'];
  return trustForwarded && typeof fwd === 'string' && fwd.split(',')[0]?.trim() === host;
}

/**
 * Whether a browser sent this request from another site (CSRF, or cross-site
 * WebSocket hijacking). The session cookie is SameSite=Lax, which stops other
 * sites but not sibling subdomains of the same registrable domain, so this is
 * checked explicitly. Fetch Metadata (`Sec-Fetch-Site`) is authoritative when
 * present; older browsers fall back to comparing `Origin` with the host.
 * Requests with neither header are not from a browser (agents' swarm calls,
 * curl) and pass; they still need a session or swarm token.
 */
export function isCrossSite(
  headers: IncomingHttpHeaders,
  opts: { trustForwarded?: boolean; allowOrigin?: string } = {},
): boolean {
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (origin && opts.allowOrigin && origin === opts.allowOrigin) return false;
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  if (!origin) return false;
  return !hostMatches(origin, headers, !!opts.trustForwarded);
}

/** Methods that can change state; these must never be cross-site. */
export function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
