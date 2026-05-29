// Operator login for the dashboard + gateway. Single-operator username/password,
// stored as a scrypt hash (never plaintext). Sessions are stateless signed
// cookies (HMAC-SHA256 over {user, exp} with a persisted secret), so they
// survive a gateway restart. All stdlib node:crypto — no deps.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSettings, updateSettings, type AuthCreds } from './settings.js';

const COOKIE_NAME = 'swarm_session';
const SESSION_TTL_MS = 7 * 86_400_000; // 7 days
const SCRYPT_KEYLEN = 64;

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
  if (username.trim() !== auth.username) return false;
  const got = Buffer.from(hashPassword(password ?? '', auth.salt), 'hex');
  const want = Buffer.from(auth.hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
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

/** Set-Cookie value establishing a session (HttpOnly, Lax, root path). */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Set-Cookie value that clears the session. */
export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
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
