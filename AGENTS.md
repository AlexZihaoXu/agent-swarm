# AGENTS.md

Guidance for AI agents working in this repository. The [README](./README.md) is
the source of truth for the architecture and decisions; keep it in sync with the
code.

## Standards & conventions

Project-wide rules. They apply everywhere in this repo, not just where you
happen to be working.

### Tooling

- **pnpm workspaces** — monorepo package manager.
- **ESLint + Prettier** — linting and formatting (lint and format are separate
  steps).
- **lefthook** — git hook manager.
- **commitlint** (`@commitlint/config-conventional`) — commit message linting.

### Commits — Conventional Commits

All commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by commitlint on the `commit-msg` hook. Allowed types:

```
feat, fix, chore, refactor, docs, test, build, ci, perf, style
```

Example: `feat(control-plane): add docker driver for agent lifecycle`

### Quality gates

Every change must pass these checks. Each is a root script, delegated to
workspaces:

| Check     | Tool     | Script         |
| --------- | -------- | -------------- |
| Format    | Prettier | `format:check` |
| Lint      | ESLint   | `lint`         |
| Typecheck | tsc      | `typecheck`    |
| Build     | —        | `build`        |

- **Pre-commit** (lefthook, run in parallel): `format:check`, `lint`,
  `typecheck`. Kept fast — typecheck is the build-correctness proxy.
- **CI**: the full `build` plus all of the above.
- Fixers: `format` (Prettier write) and `lint:fix` (ESLint `--fix`).

## Milestones

The user will explicitly use the word **milestone** to mark one. When they do,
stop and run an **integrity check** before moving on:

1. **Consistency check** — verify everything still lines up across the project:
   the README/design docs vs. the actual code and config, decisions recorded
   vs. decisions implemented, cross-file references, naming, and tooling. Look
   for drift, contradictions, and half-applied changes.

2. **Reconcile mismatches** — if something looks off or inconsistent, fix it to
   restore consistency. If the correct resolution is ambiguous (two versions
   disagree and either could be right), **don't guess — prompt the user on which
   to keep.**

3. **Challenge the approach** — if a meaningfully better alternative exists than
   the user's current solution, **bring it up and don't hesitate to ask.**
   Prefer raising it over silently complying.
