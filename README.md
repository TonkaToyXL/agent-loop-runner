# Relay

One place to run all your AI agents together. Talk to Grok, Muse, and Hermes from one dashboard, Telegram, or iMessage. Give the crew a goal and the lead agent splits it, delegates in parallel, and hands back one answer.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/TonkaToyXL/agent-loop-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/TonkaToyXL/agent-loop-runner/actions/workflows/ci.yml)
[![Node >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](./package.json)

![Relay dashboard](docs/relay-dashboard.jpg)

## What it does

- **One thread for every agent.** `@grok`, `@muse`, `@hermes`, or plain text (Relay picks the best agent from its strengths).
- **Team mode.** `@team <goal>`: the lead plans, subtasks run in parallel, the lead writes the wrap-up. Watch the baton move on the crew map.
- **Limits that reroute.** Daily request/token caps and a monthly budget per agent. When one agent is capped, auto-routed and team work moves to a teammate; direct asks stop and say why.
- **Model and reasoning labels everywhere**, editable from the dashboard or by chat (`/model grok grok-4-fast-reasoning`, `/reasoning hermes high`).
- **Dashboard:** who's working, board of queued/working/done/failed, leaderboard of who did the most work, tokens, spend, and provider rate-limit headroom when the provider reports it.
- **Phone control** through Telegram and iMessage, with allowlists.
- **Works before you add keys.** Agents without keys run in a labeled demo mode so you can try the whole flow first.

## Quick start

```bash
npm install
cp .env.example .env      # fill in what you use; every line is optional
npm run hub
```

Open http://127.0.0.1:4747.

## Connect your agents

Agents are defined in [`relay.config.json`](./relay.config.json): name, color, model, reasoning, strengths, limits, and how to reach them. Keys live only in `.env`. Each agent uses the first connector whose env vars are set, otherwise demo mode.

| Agent | Connector | `.env` |
|---|---|---|
| **Grok** | xAI API (OpenAI-compatible) | `XAI_API_KEY` |
| | or your Grok Bot routine's webhook | `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY` |
| **Muse** | Muse Spark via Meta's Model API | `MUSE_BASE_URL`, `MUSE_API_KEY` |
| **Hermes** | Hermes Agent's built-in API server | `HERMES_BASE_URL`, `HERMES_API_KEY` |

**Hermes Agent.** Turn on its API server in `~/.hermes/config.yaml`, then run `hermes gateway`:

```yaml
gateway:
  api_server:
    enabled: true
    port: 8642
    host: 127.0.0.1
    key: <same value as HERMES_API_KEY>
```

Set `HERMES_BASE_URL=http://127.0.0.1:8642/v1`.

**Muse.** Relay calls Muse Spark through Meta's API. It does not drive the Muse phone app. Copy the OpenAI-compatible base URL and the exact model ID from Meta's developer docs, then fix the model in the dashboard if it differs from `muse-spark-1.1`.

**Grok Bot webhook.** Relay POSTs `{request_id, task, context, callback_url, callback_token}` to your webhook. Tell the routine to answer by POSTing `{"result": "..."}` to `callback_url` with header `x-relay-token: <callback_token>`. A webhook that answers right away with `{"result": "..."}` works too. If the routine runs on another machine, set `RELAY_PUBLIC_URL` to an address it can reach.

**Any other agent** with an OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio) is one more entry in `relay.config.json`. Set `reasoningParam: "reasoning_effort"` on a connector only if that model accepts it.

## Telegram

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. Start the hub and message your bot. It replies with your chat id.
3. Put that id in `TELEGRAM_ALLOWED_CHAT_IDS` and restart. Anyone else gets refused.

Uses long polling, so no public URL is needed.

## iMessage

iMessage needs a Mac signed in to Messages, running [BlueBubbles Server](https://bluebubbles.app). A separate Apple ID for the bot is cleanest.

1. In `.env`: `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`, `IMESSAGE_ALLOWED_HANDLES` (your number or email), and a long random `IMESSAGE_HOOK_TOKEN`.
2. In BlueBubbles, add a webhook for **New Messages** pointing to `http://127.0.0.1:4747/hooks/imessage?token=<IMESSAGE_HOOK_TOKEN>` (use `RELAY_PUBLIC_URL` instead of 127.0.0.1 if the hub runs elsewhere).
3. Text the bot's Apple ID from your phone.

Relay ignores messages from non-allowlisted handles and its own sent messages, so replies never loop.

## Chat commands

Same everywhere: dashboard, Telegram, iMessage.

```text
@grok <ask>       talk to one agent
@team <goal>      lead plans, crew splits the work
<plain text>      auto-picks the best agent
/agents           models, reasoning, usage
/status           what's running now
/board            who did the most work
/model <agent> <model-id>
/reasoning <agent> off|low|medium|high|max
/lead <agent>     choose who plans team goals
```

## Use the dashboard from your phone

Keep `HOST=127.0.0.1` unless you need remote access. For phone access, use a private network such as Tailscale, set `HOST=0.0.0.0` and a long `HUB_TOKEN`. The hub refuses to listen beyond localhost without a token. The dashboard installs as a home-screen app.

## Data

State (tasks, usage, your model/limit edits) lives in `~/.local/share/agent-relay/hub/state.json`. Override with `RELAY_STATE`. Keys are never written there.

## PR Babysit

This repo also ships the original CLI that loops a Cursor agent on an open PR until CI is green and review threads are resolved.

```bash
export CURSOR_API_KEY="your-key"
npm run babysit-pr -- --repo owner/repo --pr-number 42 --cwd /path/to/clone
```

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repo `owner/name` (required) |
| `--pr-number` / `--pr` | PR number (required) |
| `--cwd` | Local clone path (default: cwd) |

Exit codes: `0` merge-ready, `2` merge conflicts, `3` agent run did not finish, `4` max iterations reached. Logs go to `~/.local/share/agent-relay/pr-babysit/<owner>__<repo>/pr-<number>.jsonl`. Requires `gh` authenticated for the target repo.

## Requirements

- Node.js 22.13+
- No extra runtime dependencies for the hub

## License

MIT
