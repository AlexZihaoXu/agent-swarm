// Audit / event log. Every meaningful action in the gateway — operator auth,
// agent lifecycle, raw docker commands, swarm/inter-agent calls, integrations,
// settings/registry changes, file-explorer ops, and system events — is recorded
// here. Events are:
//   - appended to an NDJSON file in the gateway-data volume (the full trail,
//     rotated at config.auditMaxBytes), and
//   - kept in a recent in-memory ring (config.auditRingSize) for fast filtered
//     queries (GET /api/audit) and a live stream (GET /api/audit/stream).
// Operator-only — the audit endpoints are NOT in swarmTokenMayAccess.
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/** Top-level buckets — drive the categorized log views in the dashboard. */
export type AuditCategory =
  | 'auth'
  | 'agent'
  | 'docker'
  | 'swarm'
  | 'integration'
  | 'settings'
  | 'file'
  | 'system';

export type AuditLevel = 'info' | 'warn' | 'error';

/** Who caused the event. `operator` = the human via the dashboard (with their
 *  client IP); `agent` = a swarm agent (its id/name); `system` = the gateway. */
export interface AuditActor {
  kind: 'operator' | 'agent' | 'system';
  id?: string;
  name?: string;
  ip?: string;
}

export interface AuditEvent {
  /** Sortable unique id: `<ts>-<seq base36>`. */
  id: string;
  ts: number;
  category: AuditCategory;
  /** Dotted action, e.g. `agent.start`, `docker.createContainer`, `auth.login.fail`. */
  action: string;
  level: AuditLevel;
  message: string;
  actor: AuditActor;
  /** The agent this event concerns (for per-agent filtering), if any. */
  agentId?: string;
  /** Secondary object — a volume name, role id, peer id, file path, etc. */
  target?: string;
  /** Wall-clock duration for operations (e.g. docker calls). */
  durationMs?: number;
  /** Whether an operation succeeded (omitted for pure notices). */
  ok?: boolean;
  /** Structured extra detail (changed fields, error message, counts, …). */
  meta?: Record<string, unknown>;
}

/** What callers pass to `logEvent` — id/ts are assigned, level defaults to info. */
export interface AuditInput extends Omit<AuditEvent, 'id' | 'ts' | 'level'> {
  level?: AuditLevel;
}

/** `YYYY-MM-DD HH:MM:SS` for an epoch-ms time in the given IANA timezone. */
export function formatTimestamp(ts: number, tz: string = config.auditTimezone): string {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(ts);
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    // en-CA gives YYYY-MM-DD for the date parts; assemble explicitly to be safe.
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

/** Minecraft-style one-liner, e.g.
 *  `[2026-06-27 14:32:05] [AGENT/INFO]: operator started workspace-X (atlas)`. */
export function formatAuditLine(ev: AuditEvent, tz: string = config.auditTimezone): string {
  const actor =
    ev.actor.kind === 'operator'
      ? `operator${ev.actor.ip ? `@${ev.actor.ip}` : ''}`
      : ev.actor.kind === 'agent'
        ? (ev.actor.name ?? ev.actor.id ?? 'agent')
        : 'system';
  return `[${formatTimestamp(ev.ts, tz)}] [${ev.category.toUpperCase()}/${ev.level.toUpperCase()}] (${actor}): ${ev.message}`;
}

export interface AuditQuery {
  from?: number;
  to?: number;
  category?: AuditCategory;
  action?: string;
  agentId?: string;
  actorKind?: AuditActor['kind'];
  level?: AuditLevel;
  /** Free-text match across message + action + actor + target. */
  q?: string;
  /** Max events to return (newest first). */
  limit?: number;
  /** Cursor: return only events with id < this (older), for pagination. */
  before?: string;
}

class AuditLog {
  private ring: AuditEvent[] = [];
  private readonly emitter = new EventEmitter();
  private seq = 0;

  constructor() {
    this.emitter.setMaxListeners(0); // many concurrent /stream subscribers
    this.loadTail();
  }

  /** Hydrate the in-memory ring from the tail of the persisted NDJSON at boot. */
  private loadTail(): void {
    try {
      if (!existsSync(config.auditFile)) return;
      const lines = readFileSync(config.auditFile, 'utf8').split('\n');
      const tail = lines.slice(-config.auditRingSize);
      for (const line of tail) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as AuditEvent;
          // Legacy events (persisted before the level default was fixed) can lack
          // a level; normalize so queries/filters and the dashboard never see undefined.
          if (!ev.level) ev.level = 'info';
          this.ring.push(ev);
        } catch {
          /* skip a corrupt line */
        }
      }
    } catch {
      /* no readable audit file yet */
    }
  }

  /** Append to the NDJSON file, rotating it first if it has grown too large. */
  private persist(ev: AuditEvent): void {
    try {
      mkdirSync(dirname(config.auditFile), { recursive: true });
      try {
        if (statSync(config.auditFile).size > config.auditMaxBytes) {
          renameSync(config.auditFile, `${config.auditFile}.1`); // keep one backup
        }
      } catch {
        /* file doesn't exist yet — nothing to rotate */
      }
      appendFileSync(config.auditFile, JSON.stringify(ev) + '\n');
    } catch {
      /* best-effort — never let logging break the request it describes */
    }
  }

  /** Record an event: assign id/ts, ring-buffer it, persist it, emit it. */
  record(input: AuditInput): AuditEvent {
    const ts = Date.now();
    const ev: AuditEvent = {
      id: `${ts}-${(this.seq++).toString(36)}`,
      ts,
      ...input,
      // After the spread so an explicit `level: undefined` (e.g. an optional
      // level arg that wasn't set) still defaults to 'info' instead of clobbering.
      level: input.level ?? 'info',
    };
    this.ring.push(ev);
    const overflow = this.ring.length - config.auditRingSize;
    if (overflow > 0) this.ring.splice(0, overflow);
    this.persist(ev);
    // Mirror to the gateway console in Minecraft style so `docker logs` matches.
    const line = formatAuditLine(ev);
    if (ev.level === 'error') console.error(line);
    else if (ev.level === 'warn') console.warn(line);
    else console.log(line);
    this.emitter.emit('event', ev);
    return ev;
  }

  /** Does an event satisfy a query's predicates (excluding limit/before)? */
  private matches(ev: AuditEvent, query: AuditQuery): boolean {
    if (query.from !== undefined && ev.ts < query.from) return false;
    if (query.to !== undefined && ev.ts > query.to) return false;
    if (query.category && ev.category !== query.category) return false;
    if (query.action && ev.action !== query.action) return false;
    if (query.agentId && ev.agentId !== query.agentId) return false;
    if (query.actorKind && ev.actor.kind !== query.actorKind) return false;
    if (query.level && ev.level !== query.level) return false;
    if (query.q) {
      const hay =
        `${ev.message} ${ev.action} ${ev.actor.name ?? ''} ${ev.actor.id ?? ''} ${ev.actor.ip ?? ''} ${ev.target ?? ''}`.toLowerCase();
      if (!hay.includes(query.q.toLowerCase())) return false;
    }
    return true;
  }

  /** Filtered, newest-first, paginated query over the in-memory ring. */
  query(query: AuditQuery = {}): { events: AuditEvent[]; hasMore: boolean } {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const out: AuditEvent[] = [];
    let hasMore = false;
    // Walk newest → oldest.
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const ev = this.ring[i]!;
      if (query.before && ev.id >= query.before) continue;
      if (!this.matches(ev, query)) continue;
      if (out.length >= limit) {
        hasMore = true;
        break;
      }
      out.push(ev);
    }
    return { events: out, hasMore };
  }

  /** Subscribe to live events (optionally filtered). Returns an unsubscribe fn. */
  subscribe(fn: (ev: AuditEvent) => void, query: AuditQuery = {}): () => void {
    const handler = (ev: AuditEvent) => {
      if (this.matches(ev, query)) fn(ev);
    };
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  /** Category + per-agent counts over the in-memory window — for the filter UI. */
  stats(): { total: number; byCategory: Record<string, number>; byLevel: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const ev of this.ring) {
      byCategory[ev.category] = (byCategory[ev.category] ?? 0) + 1;
      byLevel[ev.level] = (byLevel[ev.level] ?? 0) + 1;
    }
    return { total: this.ring.length, byCategory, byLevel };
  }
}

/** Process-wide singleton. */
export const auditLog = new AuditLog();

/** Record an audit event (the one call sites use). Best-effort, never throws. */
export function logEvent(input: AuditInput): void {
  try {
    auditLog.record(input);
  } catch {
    /* logging must never break the operation it describes */
  }
}

/** Time + run an async docker operation, recording it as a `docker.<action>`
 *  event with duration + ok/err. Wraps the dockerode calls that mutate state. */
export async function auditDocker<T>(
  action: string,
  target: string | undefined,
  actor: AuditActor,
  fn: () => Promise<T>,
  agentId?: string,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    logEvent({
      category: 'docker',
      action: `docker.${action}`,
      message: `docker ${action}${target ? ` ${target}` : ''}`,
      actor,
      agentId,
      target,
      ok: true,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (e) {
    logEvent({
      category: 'docker',
      action: `docker.${action}`,
      level: 'error',
      message: `docker ${action}${target ? ` ${target}` : ''} failed: ${e instanceof Error ? e.message : String(e)}`,
      actor,
      agentId,
      target,
      ok: false,
      durationMs: Date.now() - started,
      meta: { error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}

/** The actor for gateway-internal actions (watchdogs, boot, reconnects). */
export const SYSTEM_ACTOR: AuditActor = { kind: 'system' };
