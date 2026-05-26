#!/bin/sh
# Claude Code statusLine command. Claude pipes a JSON status payload on stdin
# (model, cost, lines, …) on every TUI update. We persist it for the Agent Swarm
# dashboard to read, then print a concise line for the in-agent TUI.
payload=$(cat)
printf '%s' "$payload" > "$HOME/.claude/statusline.json" 2>/dev/null

printf '%s' "$payload" | jq -r '
  (.model.display_name // "claude") as $m
  | ((.cost.total_cost_usd // 0) * 100 | floor / 100) as $c
  | "\($m)  ·  $\($c)  ·  +\(.cost.total_lines_added // 0)/-\(.cost.total_lines_removed // 0)"
' 2>/dev/null || printf 'claude'
