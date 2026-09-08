// Catalog of providers + their model lists for the dashboard UI. The gateway
// is the single source of truth so the dashboard's create/settings dropdowns
// stay in sync.
//
// 'anthropic' uses Claude Code's native OAuth path (no proxy, no
// ANTHROPIC_BASE_URL override). 'opencodeGo' routes through the in-agent
// oc-go-cc binary which translates Claude's Anthropic Messages requests into
// OpenAI Chat Completions for opencode.ai/zen/go/v1.
//
// The OpenCode Go model list is fetched LIVE from
//   https://opencode.ai/zen/go/v1/models
// with a 1-hour cache and a hardcoded fallback (the list at the time of
// writing) so a network blip doesn't empty the dropdown.
import type { ProviderInfo } from './types.js';

const ANTHROPIC: ProviderInfo = {
  key: 'anthropic',
  auth: 'account',
  label: 'Anthropic Claude',
  models: [
    { label: 'Default', value: '' },
    { label: 'Opus', value: 'opus' },
    { label: 'Sonnet', value: 'sonnet' },
    { label: 'Haiku', value: 'haiku' },
    { label: 'Fable', value: 'fable' },
  ],
};

/** Hardcoded fallback for OpenCode Go — used when the live /models fetch
 *  fails. Update when OpenCode adds models you want to surface offline. */
/** ChatGPT via a Codex subscription. Authenticated by OAuth, so the dashboard
 *  renders a Connect flow rather than a key field. Model ids are the ones the
 *  Codex backend accepts; 'Default' lets the backend choose. */
const CHATGPT: ProviderInfo = {
  key: 'chatgpt',
  auth: 'oauth',
  label: 'ChatGPT (Codex)',
  // ENUMERATED BY PROBING the live backend with a ChatGPT account — there is no
  // models endpoint (codex/models 400s, backend-api/models 403s). Anything not
  // listed here came back "not supported when using Codex with a ChatGPT
  // account": the -codex ids are API-key-only, and so are the bare family names
  // (gpt-6, gpt-5.6) and the Astra variants (gpt-6-astra-mini/-pro/-codex).
  // Re-probe when OpenAI ships new models — the set MOVES, it does not only grow.
  //
  // Re-probed 2026-09-08, which is how gpt-5.4 came off this list: OpenAI had
  // dropped it from the ChatGPT path and it was still our Default, so every
  // agent left on Default was talking to a model the backend refused.
  //
  // Context windows for the 5.x ids are MEASURED, not published: probed
  // 2026-07-28 by growing the input until the stream returned
  // `context_length_exceeded`, so they are floors rather than exact figures.
  // Astra's is OpenAI's published 1,050,000 and has NOT been measured here.
  // Worth surfacing because they differ by ~4x across the list, and because
  // Claude Code caps itself at 200k for these ids unless
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS is set — so the extra room is only reachable
  // when that override is on.
  models: [
    { label: 'Default (gpt-6-astra) — 1.05M ctx', value: '' },
    { label: 'GPT-6 Astra — 1.05M ctx', value: 'gpt-6-astra' },
    { label: 'GPT-5.6 Sol — 355k ctx', value: 'gpt-5.6-sol' },
    { label: 'GPT-5.6 Terra — 355k ctx', value: 'gpt-5.6-terra' },
    { label: 'GPT-5.6 Luna — 355k ctx', value: 'gpt-5.6-luna' },
    { label: 'GPT-5.5 — 245k ctx', value: 'gpt-5.5' },
    { label: 'GPT-5.4 mini — 245k ctx', value: 'gpt-5.4-mini' },
  ],
};

const OPENCODE_GO_FALLBACK_IDS: string[] = [
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'kimi-k2.6',
  'kimi-k2.5',
  'glm-5.1',
  'glm-5',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'qwen3.7-max',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'hy3-preview',
];

/** Pretty-print an OpenCode Go model id. Strategy: try each family pattern
 *  from longest prefix to shortest so "hy3-preview" → fam="HY3" wins over the
 *  generic "hy"-prefix path. Examples — glm-5.1 → "GLM 5.1"; deepseek-v4-pro →
 *  "DeepSeek V4 Pro"; kimi-k2.6 → "Kimi K2.6"; qwen3.6-plus → "Qwen 3.6 Plus";
 *  minimax-m2.7 → "MiniMax M2.7"; mimo-v2.5 → "MiMo V2.5"; hy3-preview →
 *  "HY3 Preview". */
function prettyLabel(id: string): string {
  // Ordered families: longer prefixes first so they win lookup.
  const families: { prefix: string; label: string }[] = [
    { prefix: 'deepseek', label: 'DeepSeek' },
    { prefix: 'minimax', label: 'MiniMax' },
    { prefix: 'mimo', label: 'MiMo' },
    { prefix: 'kimi', label: 'Kimi' },
    { prefix: 'qwen', label: 'Qwen' },
    { prefix: 'hy3', label: 'HY3' },
    { prefix: 'glm', label: 'GLM' },
  ];
  const lower = id.toLowerCase();
  const fam = families.find((f) => lower.startsWith(f.prefix));
  const label = fam ? fam.label : id;
  const remainder = (fam ? id.slice(fam.prefix.length) : '').replace(/^[-.]/, '');
  if (!remainder) return label;
  const rest = remainder
    .split('-')
    .map((seg) =>
      seg.length <= 2
        ? seg.toUpperCase()
        : seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase(),
    )
    .join(' ');
  return `${label} ${rest}`;
}

let cached: { at: number; ids: string[] } | null = null;
const CACHE_MS = 60 * 60 * 1000; // 1 hour

/** Fetch the live model list from OpenCode Go (with cache + fallback). The
 *  endpoint is public — no key required — so we can call it from the gateway
 *  whenever the dashboard opens the model dropdown. */
async function opencodeGoModels(): Promise<string[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ids;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    const r = await fetch('https://opencode.ai/zen/go/v1/models', { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter(Boolean);
    if (ids.length === 0) throw new Error('empty model list');
    cached = { at: Date.now(), ids };
    return ids;
  } catch {
    // Don't cache failures — we want the next call to retry.
    return OPENCODE_GO_FALLBACK_IDS;
  }
}

/** Build the dashboard's provider catalog. `await` is cheap (cached) so the
 *  /api/providers/info handler can call this on every request. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const ocgIds = await opencodeGoModels();
  // The Default entry uses '' so it round-trips to identity.model=null (the
  // proxy then picks kimi-k2.6 internally — its default tier).
  const ocgModels = [
    { label: 'Default (kimi-k2.6)', value: '' },
    ...ocgIds.map((id) => ({ label: prettyLabel(id), value: id })),
  ];
  return [
    ANTHROPIC,
    { key: 'opencodeGo', auth: 'apiKey', label: 'OpenCode Go', models: ocgModels },
    CHATGPT,
  ];
}
