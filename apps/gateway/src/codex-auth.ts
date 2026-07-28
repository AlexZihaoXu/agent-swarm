/**
 * "Sign in with ChatGPT" for the Codex provider, via OAuth DEVICE-CODE.
 *
 * Codex's default flow runs a callback server on localhost:1455 and opens a
 * browser on the same machine. That's wrong here: the gateway is containerised
 * and the operator is usually on a different machine, so nothing can reach that
 * callback. The device flow is what OpenAI provides for exactly this — we show
 * a URL and a short code, the operator approves in whatever browser they have,
 * and the gateway polls for the result.
 *
 * IMPORTANT: none of these endpoints are in OpenAI's published API docs. They
 * are what the Codex CLI itself uses, so they work but are not a contract —
 * expect to revisit this if sign-in starts failing.
 *
 * Unusually, the PKCE pair is generated SERVER-side: the poll response carries
 * `code_verifier` and `code_challenge` back to us along with the authorization
 * code, so we don't create one.
 */
import { logEvent, SYSTEM_ACTOR } from './audit.js';

/** The Codex CLI's public client id. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const BASE_URL = 'https://auth.openai.com';
/** Where the operator goes to enter the code. */
export const VERIFICATION_URL = `${BASE_URL}/codex/device`;
/** Device codes are short-lived and are a known phishing target. */
const MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_S = 5;

export interface CodexTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** ChatGPT account id — required as a header when calling the backend. */
  accountId: string | null;
  /** Best-effort account label for the dashboard (email or name from the id token). */
  account: string | null;
}

/** A login the operator still has to approve. */
export interface PendingLogin {
  userCode: string;
  verificationUrl: string;
  /** Epoch ms after which the code stops working. */
  expiresAt: number;
}

/** Decode a JWT payload without verifying — we only read display/account
 *  claims from a token the server just handed us over TLS. */
function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Pull the ChatGPT account id + a human label out of the id token. */
function identityFrom(idToken: string | undefined): {
  accountId: string | null;
  account: string | null;
} {
  if (!idToken) return { accountId: null, account: null };
  const c = jwtClaims(idToken);
  const auth = (c['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const accountId =
    (typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) ||
    (typeof c.chatgpt_account_id === 'string' && c.chatgpt_account_id) ||
    null;
  const account =
    (typeof c.email === 'string' && c.email) || (typeof c.name === 'string' && c.name) || null;
  return { accountId, account };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* pending responses can be empty */
  }
  return { status: res.status, json };
}

/**
 * One in-flight device login. Kept in memory only: it's short-lived by design,
 * and a gateway restart mid-login just means starting over.
 */
export class CodexLogin {
  private deviceAuthId = '';
  private userCode = '';
  private intervalMs = DEFAULT_INTERVAL_S * 1000;
  private expiresAt = 0;
  private cancelled = false;
  /** Set once the poll resolves OR rejects. Without this, `pending` kept
   *  reporting an outstanding code after a SUCCESSFUL login, so the dashboard
   *  sat on "waiting for approval" until the 15-minute expiry even though the
   *  account was already linked. */
  private settled = false;
  /** Resolves when the operator approves (or rejects/expires). */
  private result: Promise<CodexTokens> | null = null;

  get pending(): PendingLogin | null {
    if (this.settled || !this.userCode || Date.now() > this.expiresAt) return null;
    return {
      userCode: this.userCode,
      verificationUrl: VERIFICATION_URL,
      expiresAt: this.expiresAt,
    };
  }

  /** Ask OpenAI for a device code. Returns what the operator needs to see. */
  async start(): Promise<PendingLogin> {
    const { status, json } = await postJson('/api/accounts/deviceauth/usercode', {
      client_id: CLIENT_ID,
    });
    const j = (json ?? {}) as Record<string, unknown>;
    if (status >= 400) {
      throw Object.assign(
        new Error(
          `could not start ChatGPT sign-in (HTTP ${status}${j.error ? `: ${String(j.error)}` : ''})`,
        ),
        { statusCode: 502 },
      );
    }
    // Field naming has varied across Codex versions — accept the spellings the
    // CLI has used rather than hard-failing on one.
    const code = (j.user_code ?? j.usercode) as string | undefined;
    const id = (j.device_auth_id ?? j.deviceAuthId ?? j.id) as string | undefined;
    if (!code || !id) {
      throw Object.assign(new Error('unexpected sign-in response from OpenAI'), {
        statusCode: 502,
      });
    }
    const interval = Number(j.interval) || DEFAULT_INTERVAL_S;
    this.deviceAuthId = id;
    this.userCode = code;
    this.intervalMs = Math.max(1, interval) * 1000;
    this.expiresAt = Date.now() + MAX_WAIT_MS;
    this.cancelled = false;
    this.result = this.poll();
    // Settle in BOTH directions — a failure must clear the pending state too,
    // or the UI waits on a code that will never be approved.
    this.result.then(
      () => (this.settled = true),
      () => (this.settled = true),
    );
    // Nothing may await `result` (the operator can navigate away), so make sure
    // a rejection can't become an unhandled rejection and take the gateway down.
    this.result.catch(() => {});
    return this.pending!;
  }

  cancel(): void {
    this.cancelled = true;
    this.settled = true;
  }

  /** Await the tokens, if a login is in flight. */
  wait(): Promise<CodexTokens> | null {
    return this.result;
  }

  /** Poll until the operator approves, then exchange for tokens. */
  private async poll(): Promise<CodexTokens> {
    while (!this.cancelled && Date.now() < this.expiresAt) {
      await new Promise((r) => setTimeout(r, this.intervalMs));
      if (this.cancelled) break;
      const { status, json } = await postJson('/api/accounts/deviceauth/token', {
        device_auth_id: this.deviceAuthId,
        user_code: this.userCode,
      }).catch(() => ({ status: 0, json: null }));
      // 403/404 mean "not approved yet" — the normal case while waiting.
      if (status === 403 || status === 404 || status === 0) continue;
      const j = (json ?? {}) as Record<string, unknown>;
      if (status !== 200 || typeof j.authorization_code !== 'string') {
        throw Object.assign(new Error(`ChatGPT sign-in failed (HTTP ${status})`), {
          statusCode: 502,
        });
      }
      return await this.exchange(j.authorization_code, String(j.code_verifier ?? ''));
    }
    throw Object.assign(new Error(this.cancelled ? 'sign-in cancelled' : 'sign-in code expired'), {
      statusCode: 408,
    });
  }

  /** Trade the approved authorization code for real tokens. */
  private async exchange(code: string, codeVerifier: string): Promise<CodexTokens> {
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: `${BASE_URL}/deviceauth/callback`,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof j.access_token !== 'string') {
      throw Object.assign(new Error(`token exchange failed (HTTP ${res.status})`), {
        statusCode: 502,
      });
    }
    const { accountId, account } = identityFrom(j.id_token as string | undefined);
    logEvent({
      category: 'settings',
      action: 'settings.chatgpt.connected',
      message: `ChatGPT (Codex) account connected${account ? `: ${account}` : ''}`,
      actor: SYSTEM_ACTOR,
      // Never the tokens themselves.
      meta: { hasRefresh: typeof j.refresh_token === 'string' },
    });
    return {
      accessToken: j.access_token,
      refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null,
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      accountId,
      account,
    };
  }
}

/**
 * Refresh an access token. Codex tokens are short-lived and agents run for
 * days, so without this a working agent would start failing mid-task.
 */
export async function refreshTokens(refreshToken: string): Promise<CodexTokens> {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== 'string') {
    throw Object.assign(new Error(`ChatGPT token refresh failed (HTTP ${res.status})`), {
      statusCode: 502,
    });
  }
  const { accountId, account } = identityFrom(j.id_token as string | undefined);
  return {
    accessToken: j.access_token,
    // A refresh may or may not rotate the refresh token; keep the old one if not.
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : refreshToken,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    accountId,
    account,
  };
}
