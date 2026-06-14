# Agent Loop Runner

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/TonkaToyXL/agent-loop-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/TonkaToyXL/agent-loop-runner/actions/workflows/ci.yml)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)

CLI utilities for agent automation loops — starting with PR babysitting via [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk).

## Install

```bash
npm install
```

## PR babysit loop

Watches a pull request, checks CI and review state, and prompts a Cursor agent to fix scoped issues until the PR is merge-ready (or a blocker is hit).

```bash
export CURSOR_API_KEY="your-key"
npm run babysit-pr -- --repo owner/repo --pr-number 42 --cwd /path/to/local/clone
```

### Options

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repo in `owner/name` form (required) |
| `--pr-number` / `--pr` | PR number (required) |
| `--cwd` | Local repo path for the agent (default: current directory) |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | PR is merge-ready |
| `2` | Merge conflicts need human resolution |
| `3` | Agent run did not finish |
| `4` | Max iterations reached without merge-ready state |

### Logs

Iteration logs are appended to:

```text
~/.local/share/agent-relay/pr-babysit/<owner>__<repo>/pr-<number>.jsonl
```

## Scripts

- `npm run babysit-pr` — PR triage loop entrypoint
- `npm run build` / `npm run typecheck` — TypeScript compile checks

## Requirements

- Node.js 20+
- [`gh`](https://cli.github.com/) authenticated for the target repo
- `CURSOR_API_KEY` environment variable

## License

MIT
