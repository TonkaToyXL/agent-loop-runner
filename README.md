# PR Babysit

Loop a Cursor agent on an open pull request until CI is green and review threads are resolved.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/TonkaToyXL/agent-loop-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/TonkaToyXL/agent-loop-runner/actions/workflows/ci.yml)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)

Uses [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) and the [`gh`](https://cli.github.com/) CLI.

## Install

```bash
npm install
```

## Usage

```bash
export CURSOR_API_KEY="your-key"
npm run babysit-pr -- --repo owner/repo --pr-number 42 --cwd /path/to/clone
```

Watches CI and review state, prompts a Cursor agent to fix scoped issues, and stops when merge-ready or blocked.

### Options

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repo `owner/name` (required) |
| `--pr-number` / `--pr` | PR number (required) |
| `--cwd` | Local clone path (default: cwd) |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Merge-ready |
| `2` | Merge conflicts — needs human |
| `3` | Agent run did not finish |
| `4` | Max iterations reached |

### Logs

```text
~/.local/share/agent-relay/pr-babysit/<owner>__<repo>/pr-<number>.jsonl
```

## Requirements

- Node.js 20+
- `gh` authenticated for the target repo
- `CURSOR_API_KEY` environment variable

## License

MIT
