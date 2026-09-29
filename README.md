# agent-harness

AI coding agent harness — a minimal, self-contained implementation of the Claude Code architecture, built in TypeScript as a reference for studying agentic system design.

## Quick Start

```bash
npm install
npm run demo       # Mock provider, full pipeline walkthrough (no API key)
npm run web        # SSE + single-page UI on http://localhost:3218
npm run chat       # Real LLM (requires ANTHROPIC_API_KEY)
```

## What It Is

A **zero-dependency** harness that exercises the full Claude-style agent loop:

- **Permission waterfall**: 8-layer deny → static check → hook → rule → classifier → user modal
- **Context compression pipeline**: T0 tool result budget → T1 micro → T2 snip → T3 collapse → T4 auto → T5 reactive (413 recovery)
- **Prompt cache boundary**: stable prefix (system + tools) separated from dynamic messages
- **Streaming + tool-use parallelism**: full LLM streaming with `completeStream`, parallel tool execution
- **Web UI**: native SSE server + single-page frontend with tool cards, permission modals, session resume
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
  web/server.ts     SSE server (no deps)
demo/
  web/index.html    single-page frontend
  settings.json     permission rules + hooks + MCP servers
test/
  smoke.js          32-unit engine regression (no real API)
  web-smoke.js      9-unit Web/SSE regression (no real API)
```

## Attribution

agent-harness is a reference implementation **inspired by Claude Code's architecture**. It is an independent reimplementation written from architectural study — no proprietary source code, tooling, or binaries were used in its construction.

## License

MIT
