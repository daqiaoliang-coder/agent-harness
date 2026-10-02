# agent-harness

AI coding agent harness — a minimal, self-contained implementation of the Claude Code architecture, built in TypeScript as a reference for studying agentic system design.

## Quick Start

```bash
npm install
npm run demo       # Mock provider, full pipeline walkthrough (no API key)
npm run web        # SSE + single-page UI on http://127.0.0.1:3218/?token=<printed-at-startup>
npm run chat       # Real LLM (key from env ANTHROPIC_API_KEY or macOS Keychain)

node dist/cli.js key set|get|rm|status   # API key management via macOS Keychain (no plaintext .env)
```

## What It Is

A **zero-dependency** harness that exercises the full Claude-style agent loop:

- **Permission waterfall**: 8-layer deny → static check → hook → rule → classifier → user modal
- **Context compression pipeline**: T0 tool result budget → T1 micro → T2 snip → T3 collapse → T4 auto → T5 reactive (413 recovery)
- **Prompt cache boundary**: stable prefix (system + tools) separated from dynamic messages
- **Streaming + tool-use parallelism**: full LLM streaming with `completeStream`, parallel tool execution with a concurrency cap and per-file edit mutex (no lost updates, no resource exhaustion)
- **Cooperative abort**: `AbortSignal` threaded through LLM fetch → tools → compact side queries → permission waits; aborted turns keep the message tree consistent (every `tool_use` gets a paired `tool_result`)
- **Crash-safe sessions**: transcript crash repair on `--resume` (orphaned `tool_use` gets a synthetic error result persisted; orphaned `tool_result` dropped) — a crashed session always reopens
- **Budget guard**: configurable `maxTurns` + session-wide token budget circuit breaker (`settings.json` `engine` section) so a runaway loop can't burn tokens unchecked
- **Credential management**: API key stored in the macOS Keychain via the `key` subcommand (`security` CLI, zero deps); resolution order `ANTHROPIC_API_KEY` env → Keychain → mock/demo mode
- **Web UI, multi-session**: native SSE server + single-page frontend with tool cards, permission modals, session resume, stop button; multiple concurrent sessions (per-session serial queue, LRU cap 8, per-session abort), all SSE events tagged with `sessionId` so multiple tabs can watch different sessions; loopback-bound with startup token auth (all endpoints, incl. SSE/static page)
- **Error telemetry**: engine-level exceptions classified (provider/budget/compact/hook/engine) and appended to `.agent-harness/telemetry/errors.jsonl`; tool-level failures counted; user aborts never counted as errors; exposed via `GET /api/stats` (Web) and an exit summary (chat)
- **Hooks system**: `.claudeignore`-style hooks with stdout-JSON + exit-code protocol
- **MCP integration**: stdio JSON-RPC server/client

## Architecture

```
               ┌─────────────────────┐
   chat/ ────► │     createSession   │◄──── web (SSE)
   demo/       │  (hooks · perm ·    │
               │   tools · compact)  │
               └────────┬────────────┘
                        │ QueryDeps (emit + renderDelta)
                        ▼
               ┌─────────────────────┐
               │     runQuery        │ ◄── permission waterfall
               │  main-loop FSM      │ ◄── compact T0-T5
               │  (tool_use par)     │ ◄── hooks / cache boundary
               └────────┬────────────┘
                        │
               ┌────────┴────────────┐
               │   LLMProvider        │
               │  Mock / Anthropic   │
               └─────────────────────┘
```

The engine is **UI-agnostic**. Both the readline CLI and the SSE Web server are thin frontends over the same `createSession` + `runQuery` core. UI events flow out through an optional `emit` callback — CLI ignores it, Web collects it into a typed event bus.

## Layout

```
src/
  query.ts          main-loop state machine (7 branches)
  permissions/      8-layer waterfall + rules + static checks + classifier
  compact/          T0 budget · T1 micro · T2 snip · T3 collapse · T4 auto · T5 reactive
  context/          prompt cache boundary + token estimator
  hooks/            hook runner + event registry
  tools/            Bash Read Write Edit Glob Grep Task + ToolRegistry
  llm/              MockProvider (scripted) + AnthropicProvider (zero-dep fetch)
  mcp/              stdio JSON-RPC server/client
  agent/            read-only explore subagent (independent context)
  session/          transcript resume
  credentials/      API key management (macOS Keychain via security CLI)
  telemetry/        error classification + JSONL log + stats
  web/server.ts     SSE server, multi-session (no deps)
demo/
  web/index.html    single-page frontend
  settings.json     permission rules + hooks + MCP servers
test/
  smoke.js          47-unit engine regression (no real API)
  web-smoke.js      19-unit Web/SSE regression (auth + abort e2e + multi-session + telemetry, no real API)
```

## Attribution

agent-harness is a reference implementation **inspired by Claude Code's architecture**. It is an independent reimplementation written from architectural study — no proprietary source code, tooling, or binaries were used in its construction.

## License

MIT
