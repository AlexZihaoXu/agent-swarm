// Catalog of providers + their model lists for the dashboard UI. The gateway
// is the single source of truth so the dashboard's create/settings dropdowns
// stay in sync as we add models without touching the front-end.
//
// 'anthropic' uses Claude Code's native OAuth path (no proxy, no
// ANTHROPIC_BASE_URL override). 'opencodeGo' routes through the in-agent
// opencode-proxy.py which translates Claude's Anthropic Messages requests
// into OpenAI Chat Completions for opencode.ai/zen/go/v1.
import type { ProviderInfo } from './types.js';

export const PROVIDERS: ProviderInfo[] = [
  {
    key: 'anthropic',
    label: 'Anthropic Claude',
    models: [
      { label: 'Default', value: '' },
      { label: 'Opus', value: 'opus' },
      { label: 'Sonnet', value: 'sonnet' },
      { label: 'Haiku', value: 'haiku' },
    ],
  },
  {
    key: 'opencodeGo',
    label: 'OpenCode Go',
    // Mirrors GET https://opencode.ai/zen/go/v1/models. Update this list as
    // OpenCode Go adds/removes models. Empty value = the proxy's default
    // (currently kimi-k2.6).
    models: [
      { label: 'Default (kimi-k2.6)', value: '' },
      { label: 'GLM 5.1', value: 'glm-5.1' },
      { label: 'GLM 5', value: 'glm-5' },
      { label: 'Kimi K2.6', value: 'kimi-k2.6' },
      { label: 'Kimi K2.5', value: 'kimi-k2.5' },
      { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
      { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
      { label: 'MiniMax M3', value: 'minimax-m3' },
      { label: 'MiniMax M2.7', value: 'minimax-m2.7' },
      { label: 'MiniMax M2.5', value: 'minimax-m2.5' },
      { label: 'Qwen 3.7 Max', value: 'qwen3.7-max' },
      { label: 'Qwen 3.6 Plus', value: 'qwen3.6-plus' },
      { label: 'Qwen 3.5 Plus', value: 'qwen3.5-plus' },
    ],
  },
];
