// Operator login for the dashboard + gateway. Single-operator username/password,
// stored as a scrypt hash (never plaintext). Sessions are stateless signed
// cookies (HMAC-SHA256 over {user, exp} with a persisted secret), so they
// survive a gateway restart. All stdlib node:crypto — no deps.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSettings, updateSettings, type AuthCreds } from './settings.js';
import { logEvent } from './audit.js';

const COOKIE_NAME = 'swarm_session';
const SESSION_TTL_MS = 7 * 86_400_000; // 7 days
const SCRYPT_KEYLEN = 64;

// ── Login brute-force throttle ────────────────────────────────────────────────
// In-memory, per-source-IP failed-attempt tracker. A handful of misses inside a
// rolling window are free (legit typos); past that the IP is blocked with
// exponential backoff. A successful login clears the IP entirely. State lives in
// process memory only (resets on restart) — no dep, no persistence needed for a
// single-operator gateway.
const LOGIN_FREE_FAILS = 5; // misses allowed before backoff kicks in
const LOGIN_WINDOW_MS = 15 * 60_000; // rolling window; idle this long → counter resets
const LOGIN_BACKOFF_BASE_MS = 30_000; // first block: 30s, then 60s, 120s, …
const LOGIN_BACKOFF_MAX_MS = 15 * 60_000; // cap each block at ~15m
const LOGIN_PRUNE_MAX = 10_000; // hard cap on tracked IPs (DoS guard)

// Global (all-IP) circuit breaker. The per-IP throttle is only as good as the
// IP attribution — an attacker rotating source addresses (botnet, or forged
// forwarding headers if they can reach the origin directly) gets a fresh
// bucket each time. This is the backstop: too many TOTAL failures in the
// window means someone is brute-forcing, so block ALL logins briefly with
// escalating backoff. For a single-operator gateway, locking the front door
// for a minute during an active attack is the right trade.
const GLOBAL_FREE_FAILS = 25; // total misses tolerated per window
const GLOBAL_BACKOFF_BASE_MS = 60_000; // first global block: 60s, then 2×, …
const GLOBAL_BACKOFF_MAX_MS = 60 * 60_000; // cap at 1h

interface LoginAttempt {
  fails: number;
  firstTs: number;
  blockedUntil: number;
}
const loginAttempts = new Map<string, LoginAttempt>();
const globalAttempts: LoginAttempt = { fails: 0, firstTs: 0, blockedUntil: 0 };

/** Drop entries past their window and not currently blocked; then, if a flood of
 *  still-live entries keeps the map over the cap, evict the oldest (insertion-
 *  ordered) so it can't grow without bound. */
function pruneLoginAttempts(now: number): void {
  for (const [ip, a] of loginAttempts) {
    if (a.blockedUntil <= now && now - a.firstTs > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
  if (loginAttempts.size > LOGIN_PRUNE_MAX) {
    let excess = loginAttempts.size - LOGIN_PRUNE_MAX;
    for (const ip of loginAttempts.keys()) {
      if (excess-- <= 0) break;
      loginAttempts.delete(ip);
    }
  }
}

/**
 * Is this IP currently blocked from attempting a login? Call BEFORE checking the
 * password. `retryAfterSec` is the (ceil) seconds until the block lifts — feed it
 * straight into a `Retry-After` header. A clean/under-threshold IP is never
 * blocked, so a correct first-try login is unaffected.
 */
export function loginThrottle(ip: string): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (globalAttempts.blockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((globalAttempts.blockedUntil - now) / 1000) };
  }
  const a = loginAttempts.get(ip);
  if (a && a.blockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((a.blockedUntil - now) / 1000) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

/** Record a failed login from `ip`; arms/extends exponential backoff past the
 *  free-fail allowance. Resets the counter if the previous window has lapsed. */
export function noteLoginFailure(ip: string): void {
  const now = Date.now();
  if (loginAttempts.size > LOGIN_PRUNE_MAX) pruneLoginAttempts(now);
  let a = loginAttempts.get(ip);
  // Start a fresh window if there's no record or the last one has gone stale.
  if (!a || (a.blockedUntil <= now && now - a.firstTs > LOGIN_WINDOW_MS)) {
    a = { fails: 0, firstTs: now, blockedUntil: 0 };
    loginAttempts.set(ip, a);
  }
  a.fails += 1;
  if (a.fails > LOGIN_FREE_FAILS) {
    // 6th fail → base, 7th → 2×, 8th → 4×, … capped. Block extends from `now`.
    const over = a.fails - LOGIN_FREE_FAILS - 1; // 0,1,2,…
    const backoff = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** over, LOGIN_BACKOFF_MAX_MS);
    a.blockedUntil = now + backoff;
  }

  // Feed the global breaker too. Its window restarts once stale, same as per-IP.
  if (globalAttempts.blockedUntil <= now && now - globalAttempts.firstTs > LOGIN_WINDOW_MS) {
    globalAttempts.fails = 0;
    globalAttempts.firstTs = now;
  }
  globalAttempts.fails += 1;
  if (globalAttempts.fails > GLOBAL_FREE_FAILS) {
    const over = globalAttempts.fails - GLOBAL_FREE_FAILS - 1;
    const backoff = Math.min(GLOBAL_BACKOFF_BASE_MS * 2 ** over, GLOBAL_BACKOFF_MAX_MS);
    globalAttempts.blockedUntil = now + backoff;
    logEvent({
      category: 'auth',
      action: 'auth.breaker.trip',
      level: 'error',
      message: `global login breaker tripped: ${globalAttempts.fails} failures in window — all logins blocked for ${Math.round(backoff / 1000)}s`,
      actor: { kind: 'system' },
      meta: { fails: globalAttempts.fails, blockSeconds: Math.round(backoff / 1000) },
    });
  }
}

/** Clear all throttle state for `ip` after a successful login. */
export function noteLoginSuccess(ip: string): void {
  loginAttempts.delete(ip);
}

/** Test-only: wipe the throttle state between cases. */
export function _resetLoginThrottle(): void {
  loginAttempts.clear();
  globalAttempts.fails = 0;
  globalAttempts.firstTs = 0;
  globalAttempts.blockedUntil = 0;
}

/** Whether an operator login has been set (false → show first-run setup). */
export function isConfigured(): boolean {
  return !!getSettings().auth;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

/** Create the operator login (first-run only). Also mints the session secret. */
export function setupCredentials(username: string, password: string): void {
  const u = username.trim();
  if (!u) throw Object.assign(new Error('username required'), { statusCode: 400 });
  if ((password ?? '').length < 8)
    throw Object.assign(new Error('password must be at least 8 characters'), { statusCode: 400 });
  const salt = randomBytes(16).toString('hex');
  const auth: AuthCreds = { username: u, salt, hash: hashPassword(password, salt) };
  const sessionSecret = getSettings().sessionSecret || randomBytes(32).toString('hex');
  updateSettings({ auth, sessionSecret });
}

/** Constant-time check of a username + password against the stored hash. */
export function verifyPassword(username: string, password: string): boolean {
  const auth = getSettings().auth;
  if (!auth) return false;
  // Run the (deliberately slow) hash even when the username doesn't match, so
  // response timing can't be used to probe which usernames exist.
  const got = Buffer.from(hashPassword(password ?? '', auth.salt), 'hex');
  const want = Buffer.from(auth.hash, 'hex');
  const passOk = got.length === want.length && timingSafeEqual(got, want);
  return username.trim() === auth.username && passOk;
}

/** Change the password after verifying the current one. */
export function changePassword(currentPassword: string, newPassword: string): void {
  const auth = getSettings().auth;
  if (!auth) throw Object.assign(new Error('not configured'), { statusCode: 400 });
  if (!verifyPassword(auth.username, currentPassword))
    throw Object.assign(new Error('current password is incorrect'), { statusCode: 403 });
  if ((newPassword ?? '').length < 8)
    throw Object.assign(new Error('password must be at least 8 characters'), { statusCode: 400 });
  const salt = randomBytes(16).toString('hex');
  // Rotate the session secret too, so other sessions are invalidated.
  updateSettings({
    auth: { username: auth.username, salt, hash: hashPassword(newPassword, salt) },
    sessionSecret: randomBytes(32).toString('hex'),
  });
}

function secret(): string {
  let s = getSettings().sessionSecret;
  if (!s) {
    s = randomBytes(32).toString('hex');
    updateSettings({ sessionSecret: s });
  }
  return s;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/** Mint a signed session cookie value for a user. */
export function issueToken(username: string): string {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Validate a session token; returns the username or null. */
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const [payloadB64, mac] = token.split('.');
  if (!payloadB64 || !mac) return null;
  const expected = sign(payloadB64);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as {
      u: string;
      exp: number;
    };
    if (typeof exp !== 'number' || exp < Date.now()) return null;
    return u;
  } catch {
    return null;
  }
}

/** Pull our session cookie out of a Cookie header. */
export function sessionFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Whether the request carries a valid session. */
export function isAuthed(cookieHeader: string | undefined): boolean {
  return verifyToken(sessionFromCookie(cookieHeader)) !== null;
}

/** Set-Cookie value establishing a session (HttpOnly, Lax, root path). `Secure`
 *  is appended only over HTTPS — on plain HTTP it must be omitted or the browser
 *  drops the cookie and login breaks. */
export function sessionCookie(token: string, isSecure = false): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${
    isSecure ? '; Secure' : ''
  }`;
}

/** Set-Cookie value that clears the session. */
export function clearCookie(isSecure = false): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecure ? '; Secure' : ''}`;
}

/** The shared token agents present so their machine-to-machine calls to the
 *  gateway pass the operator-login gate. Generated + persisted on first use. */
export function swarmToken(): string {
  let t = getSettings().swarmSecret;
  if (!t) {
    t = randomBytes(32).toString('hex');
    updateSettings({ swarmSecret: t });
  }
  return t;
}

/** Endpoints the machine-to-machine swarm token may reach — exactly the agent-
 *  facing routes the in-agent swarm tools (swarm.py) call: the roster + groups
 *  it reads, and the agent↔agent messaging/manage/view actions. Everything else
 *  (operator settings incl. the OAuth token, other agents' files, agent
 *  lifecycle, the dashboard, the agent proxy) stays operator-session-only, so a
 *  leaked or prompt-injected agent can't reuse its swarm token to pivot beyond
 *  agent↔agent calls. No legitimate agent request falls outside this set. */
export function swarmTokenMayAccess(method: string, pathname: string): boolean {
  if (pathname.startsWith('/api/swarm/')) return true;
  if (method === 'GET' && (pathname === '/api/agents' || pathname === '/api/groups')) return true;
  return false;
}

/** Constant-time check of an agent's x-swarm-token header. */
export function validSwarmToken(header: string | string[] | undefined): boolean {
  const got = Array.isArray(header) ? header[0] : header;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(swarmToken());
  return a.length === b.length && timingSafeEqual(a, b);
}
