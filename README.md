# agent-harness

AI coding agent harness — a minimal, self-contained implementation of the Claude Code architecture, built in TypeScript as a reference for studying agentic system design.

**Zero runtime dependencies** · 51 source files · ~19K lines TypeScript · 195 smoke tests · Node.js ≥ 18

## Quick Start

```bash
npm install
npm run demo       # Mock provider, full pipeline walkthrough (no API key needed)
npm run web        # SSE + single-page UI on http://127.0.0.1:3218/?token=<printed-at-startup>
npm run chat       # Real LLM (key from env ANTHROPIC_API_KEY or macOS Keychain)
```

### Headless / CI

```bash
node dist/cli.js chat -p "summarize this repo" --output-format json   # single-shot (claude -p equivalent)
cat app.log | node dist/cli.js chat -p "find anomalies"               # stdin as extra context
cat prompt.txt | node dist/cli.js chat --output-format stream-json    # no -p: stdin is the prompt
```

### Other Subcommands

```bash
node dist/cli.js key set|get|rm|status   # API key via macOS Keychain (no plaintext .env)
node dist/cli.js sessions list|search|export|fork
node dist/cli.js --help                  # full CLI reference (also: <sub> --help)
```

## Architecture Overview

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
               │  main-loop FSM      │ ◄── compact T0–T5
               │  (tool_use par)     │ ◄── hooks / cache boundary
               └────────┬────────────┘
                        │
               ┌────────┴────────────┐
               │   LLMProvider        │
               │  Mock / Anthropic   │
               └─────────────────────┘
```

The engine is **UI-agnostic**. Both the readline CLI and the SSE Web server are thin frontends over the same `createSession` + `runQuery` core. UI events flow out through an optional `emit` callback — CLI ignores it, Web collects it into a typed event bus.

### Module Dependency Map

```
cli.ts (entry)
 ├─ settings/loader.ts ──── 3-layer config merge
 │   └─ settings/memory.ts ──── CLAUDE.md / AGENTS.md → system prompt
 ├─ credentials/keychain.ts ──── API key resolution
 ├─ llm/ ──── LLM providers (Anthropic / Mock)
 │   └─ context/ ──── cache boundary + token estimator
 ├─ tools/ ──── 12 built-in tools + ToolRegistry
 │   ├─ fileState.ts ──── Read/Write/Edit freshness tracking
 │   ├─ validate.ts ──── input schema validation
 │   └─ diagnostics.ts ──── build failure re-injection
 ├─ permissions/ ──── 8-layer waterfall
 │   ├─ rules.ts ──── asymmetric deny/allow normalization
 │   ├─ staticChecks.ts ──── Bash safety validators
 │   └─ classifier.ts ──── two-stage LLM classifier
 ├─ hooks/ ──── external script runner
 ├─ mcp/ ──── stdio JSON-RPC server/client
 ├─ agent/ ──── read-only explore subagent
 ├─ compact/ ──── 6-tier compression (T0–T5)
 ├─ session/ ──── crash recovery + list/search/export/fork
 ├─ telemetry/ ──── local error/usage JSONL tracking
 ├─ events.ts ──── EventBus pub/sub
 ├─ commands.ts ──── slash command registry
 └─ query.ts ──── main-loop state machine
```

## Core Features

### Main Loop (`query.ts`)

Named-continue branch state machine. Each turn:

1. Check compression watermarks → trigger T2 snip / T3 collapse / T4 auto if needed
2. Call LLM with cache-optimized request → 413 triggers T5 reactive compact recovery
3. Dispatch tool calls in parallel (max 4 concurrent, per-file edit mutex)
4. No tool calls → conversation turn done
5. Circuit breaker on consecutive failures; `maxTurns` + token budget guards

### Permission Waterfall (`permissions/`)

8-layer cascade, evaluated in order — first decisive layer wins:

| Layer | Name | Behavior |
|-------|------|----------|
| 1 | **Deny rules** | Reject immediately, no override |
| 2 | **Static checks** | Per-tool built-in safety (`checkPermissions`) |
| 2' | **Plan mode gate** | Read-only tools only in plan mode |
| 3 | **PreToolUse hooks** | External script verdict (exit code + JSON protocol) |
| 4 | **bypassPermissions** | Auto-approve all (requires `--dangerous`) |
| 5' | **Session memory** | "Always allow" remembered decisions |
| 5 | **Ask rules** | Force user prompt |
| 6 | **Allow rules** | Auto-approve matching patterns |
| 7 | **Auto-mode classifier** | Two-stage LLM safety classifier |
| 8 | **User prompt** | Final fallback — diff preview for Edit/Write |

Session "always allow" memory overrides ask rules but never deny rules, static checks, or hooks. The permission modal renders Edit/Write diff previews and supports session-scoped prefix matching (`git push origin main` → `Bash(git push:*)`).

**Rule syntax**: `"Bash(seq:*)"` with asymmetric normalization — deny rules aggressively strip env vars + wrappers (sudo/nohup); allow rules conservatively strip only safe env vars. Dangerous env vars (PATH, LD_PRELOAD, etc.) are never stripped.

**Bash static checks**: deny validators for `rm -rf`, `sudo`, `curl|sh`, `dd`, `mkfs`, fork bombs, `chmod 777 /`, `eval base64`, `history -c`; ask validators for `git push --force`, `git reset --hard`.

### Context Compression (`compact/`)

6-tier pipeline, progressively more aggressive:

| Tier | Name | Strategy |
|------|------|----------|
| T0 | **Tool result budget** | Results > 2K tokens → archived to disk + frozen preview marker |
| T1 | **Micro compact** | Clear old tool results in API view, keep recent 3 messages |
| T2 | **Snip** | No-LLM archive of oldest tool exchanges to disk, replace with marker |
| T3 | **Context collapse** | LLM-summarize oldest segment at 90/92/94% watermarks |
| T4 | **Auto compact** | 9-section summary template + restore budget (re-read up to 5 archived files) |
| T5 | **Reactive compact** | 413 recovery — keep last 4 messages + full summary, one-shot guard |

Effective window = `contextWindow − min(maxOutput, 20K)`. Each tier that rewrites the message tree resets the cache boundary so the stable prefix remains reusable.

### Prompt Cache (`context/`)

Three `cache_control` breakpoints in the API request body: system last block, tools array tail, and a message-history stable boundary. Any compression rewrite resets the boundary to the new tail.

SHA256-based prefix keys for cache hit/miss detection. The MockProvider mirrors this with two-segment fingerprints logged per turn as `[cache] HIT/MISS p1/p2`.

Deterministic serialization (`stableStringify`) and stable tool ordering ensure cache prefix stability across turns.

### Streaming & Retry (`llm/anthropicProvider.ts`)

Full SSE streaming with `text_delta` + `input_json_delta` aggregation. Three-stage retry matrix:

- **Connect-phase errors**: network failures before response → retry with backoff
- **Retriable non-200**: 408/409/429/5xx/529 → retry with exponential backoff + jitter
- **Mid-stream drops**: before any delta rendered → retry; after render → fail cleanly (partial text kept, never re-streamed)

Request bytes are identical on retry so the cache prefix still hits.

### Built-in Tools (`tools/`)

| Tool | Permission | Description |
|------|-----------|-------------|
| **Bash** | Full waterfall | Shell execution via `spawn("bash")`, 30s default / 10min max timeout, 200K output cap, detached process group |
| **Read** | Static allow | File reading, max 100K chars, records mtime+size snapshots for Edit freshness |
| **Write** | Full waterfall | File writing with per-file mutex, creates parent dirs |
| **Edit** | Full waterfall | Exact string replacement with freshness enforcement; single or `edits[]` multi-edit (atomic — first failure rolls back all) |
| **Glob** | Static allow | Custom `globToRegex`, results sorted by mtime desc, max 100 results |
| **Grep** | Static allow | Regex line matching, max 1MB file size, binary detection, max 50 results |
| **TodoWrite** | Static allow | Full-replacement task list (Claude Code semantics), SSE snapshot to Web panel |
| **WebSearch** | Static allow | DuckDuckGo HTML (zero API key), 15s timeout, max 10 results, 16K output cap |
| **WebFetch** | Static allow | URL fetch with SSRF guard (hostname blacklist + redirect re-validation), HTML→text, 32K default / 100K max |
| **Git** | Conditional | Read-only subcommands (status/diff/log/show) static allow; write ops denied → Bash. Argv array spawn (no shell injection) |
| **Task** | Static allow | Spawns read-only subagent (Read/Glob/Grep only), max 50 sub-turns |

**Input validation**: dispatch-layer schema check (`required` + `typeof`) before the permission waterfall. Malformed `tool_use` never executes, never prompts — returns a self-correctable error with the full parameter signature.

**Diagnostic feedback loop** (`diagnostics.ts`): verification commands (test/lint/build) that fail are buffered (≤ 3 entries, ≤ 250 chars each); the next user message carries unresolved items as `[诊断提醒]`. A successful re-run of the same command dissolves the entry.

### Hooks System (`hooks/`)

`.claudeignore`-style hooks with dual protocol:

- **Exit code**: 0 = allow, 2 = deliberate deny, other = error (fall through)
- **Stdout JSON**: `{hookSpecificOutput: {permissionDecision}}` for structured decisions

Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PermissionDenied`. Sequential execution within event, 10s timeout. Settings hot-reload supported.

### MCP Integration (`mcp/`)

Stdio JSON-RPC 2.0 server/client. `connectMcpServers()` discovers and registers tools as `mcp__<server>__<tool>`. Single server failure degrades gracefully. 10s init timeout, 30s call timeout.

### Session Management (`session/`)

- **Crash-safe transcripts**: append-only JSONL. On `--resume`, orphaned `tool_use` gets a synthetic error result; orphaned `tool_result` is dropped. A crashed session always reopens.
- **Edit-snapshot persistence**: per-session `FileStateStore` persisted to `sessions/<id>.filestate.json` — `--resume` reloads it so unmodified files can be edited without a fresh Read.
- **Titles**: derived from first user message (head-only 64K read, 60-char cap).
- **Cross-session search**: case-insensitive substring over user/assistant text blocks (≤ 5 hits/session, ≤ 20 sessions).
- **Export**: linear markdown (tool calls as JSON blocks, results in `<details>`) or raw JSONL.
- **Fork**: copies transcript into a fresh session (optional `upto` truncation).

### Layered Settings (`settings/`)

Claude Code-style 3-layer merge: user (`~/.agent-harness/settings.json`, redirectable via `AGENT_HARNESS_HOME`) → project (`demo/settings.json`) → local (`.agent-harness/settings.json`, gitignored).

| Field | Merge strategy |
|-------|---------------|
| `permissions` (allow/deny/ask) | Union |
| `hooks` | Concatenate per event |
| `mcpServers` | Per-key override |
| `engine` / `model` | Scalar deep-override (`ANTHROPIC_MODEL` env wins) |
| `systemPromptAppend` | Concatenate |

A malformed field degrades to a warning (skipped, rest merges). A broken JSON file skips the whole layer — never a hard failure. Hot-reload via `fs.watch` (300ms debounce).

### Project Memory (`settings/memory.ts`)

Claude Code-style `CLAUDE.md` / `AGENTS.md` persistent project instructions. Loaded at session start from user-level + project-level (first hit wins). Injected into system prompt between settings append and CLI append. 64K chars soft cap per file with truncation note. Missing files stay silent.

### Slash Commands (`commands.ts`)

Shared registry behind both the chat REPL and Web input box. Commands intercepted before the LLM — unknown `/xxx` errors out instead of being sent to the model.

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Session stats + todo counts |
| `/mode default\|auto\|plan\|bypassPermissions` | Switch permission mode mid-session |
| `/permissions` | Show session "always allow" memory |
| `/usage` | Token usage (5h rolling window) |
| `/exit` | End session |

`bypassPermissions` requires `--dangerous` confirm, rejected via Web API with 400. Mode changes emit SSE events for live UI sync.

### Headless Mode

`chat -p "query"` for scripts/CI:

- **stdin pipe**: `cat log | chat -p "summarize"` (stdin as context); `cat prompt | chat` (stdin as prompt)
- **Output formats**: `--output-format text|json|stream-json`
- **Unattended permissions**: the full waterfall runs; anything that would prompt is auto-denied (model sees denial and can adapt)
- **Exit codes**: 0 = completed, 1 = system fault, 130 = forced quit
- **Sessions**: `sess_chat_*` namespace, resumable interactively and vice versa

### Web UI (`web/server.ts`)

Zero-dependency HTTP + SSE server with single-page frontend:

- Tool cards with expandable results
- Permission modals with diff preview
- Session sidebar (titles, search, fork, export)
- Mode dropdown + context usage gauge in topbar
- TodoWrite panel (☐/◐/☑, `activeForm` while in progress)
- Multi-session support (per-session serial queue, LRU cap 8, per-session abort)
- Loopback-bound with startup token auth

**14 API endpoints**: SSE events, message send, permission answer, abort, session CRUD, mode switch, usage/stats.

### Credential Management (`credentials/`)

API key stored in macOS Keychain via `security` CLI (zero deps). Resolution order: `ANTHROPIC_API_KEY` env → Keychain → mock/demo mode.

### Telemetry (`telemetry/`)

Local-only (no external services):

- **Error recording**: classified (provider/budget/compact/hook/engine) → `.agent-harness/telemetry/errors.jsonl`
- **Usage tracking**: input/output + cache read/write → `usage.jsonl`, 5-hour rolling window aggregation
- **Surfaces**: per-turn `usage` SSE event → Web topbar gauge, `GET /api/usage`, `/usage` slash command

### Cooperative Abort

`AbortSignal` threaded through LLM fetch → tools → compact side queries → permission waits. Aborted turns keep the message tree consistent (every `tool_use` gets a paired `tool_result`).

### Budget Guard

Configurable `maxTurns` (default 200) + session-wide token budget circuit breaker (via `settings.json` `engine` section) so a runaway loop can't burn tokens unchecked.

## Project Layout

```
src/
  cli.ts              entry point: arg parsing, session factory, 5 subcommands
  query.ts            main-loop state machine (7 branches)
  types.ts            core types: Message, ContentBlock, ToolResult, PermissionDecision
  events.ts           EventBus pub/sub + ~20 UiEvent types + history replay
  commands.ts         slash command registry + runtime mode switch

  permissions/
    engine.ts         8-layer permission waterfall orchestrator
    rules.ts          rule parsing + asymmetric deny/allow normalization
    staticChecks.ts   built-in Bash safety validators (deny + ask)
    classifier.ts     two-stage LLM safety classifier (block/allow + CoT review)
    preview.ts        Edit/Write diff preview + "always allow" rule derivation

  compact/
    watermarks.ts     effective window computation + threshold config
    toolResultBudget.ts  T0: large results → disk archive + frozen preview
    microCompact.ts   T1: clear old tool results, keep recent 3
    snipCompact.ts    T2: no-LLM archive of oldest exchanges
    contextCollapse.ts  T3: LLM-summarize oldest segment at watermarks
    autoCompact.ts    T4: 9-section summary + restore budget
    reactiveCompact.ts  T5: 413 recovery, keep last 4 + summary

  tools/
    tool.ts           Tool interface + ToolRegistry (stable order for cache)
    bash.ts           shell execution (spawn, timeout, detached group)
    read.ts           file reading + snapshot recording
    write.ts          file writing + mutex + parent dir creation
    edit.ts           exact replacement (single + atomic multi-edit)
    glob.ts           pattern matching (custom globToRegex, mtime sort)
    grep.ts           regex line search (binary detection, glob filter)
    todowrite.ts      full-replacement task list (SSE snapshot)
    websearch.ts      DuckDuckGo HTML search (zero API key)
    webfetch.ts       URL fetch + SSRF guard + HTML→text
    git.ts            argv-array spawn, readonly whitelist
    task.ts           read-only subagent spawning
    validate.ts       input schema validation (pre-waterfall)
    diagnostics.ts    build failure buffer + re-injection
    fileState.ts      per-session mtime/size tracking + persistence
    walk.ts           recursive dir walking + .claudeignore support

  llm/
    provider.ts       LLMProvider interface + MockProvider (scripted)
    anthropicProvider.ts  zero-dep fetch, SSE streaming, 3-stage retry, 3 cache breakpoints

  context/
    cacheBoundary.ts  cache-optimized request building + SHA256 prefix keys
    tokenEstimator.ts chars/4 heuristic token counting

  mcp/
    client.ts         stdio JSON-RPC 2.0 transport
    manager.ts        multi-server connection + graceful degradation
    mcpTool.ts        MCP tool → ToolRegistry wrapper

  hooks/
    events.ts         hook event definitions (5 events)
    runner.ts         external script runner (exit code + JSON protocol)

  agent/
    subagent.ts       read-only explore subagent (Read/Glob/Grep only)

  session/
    resume.ts         transcript loading + crash repair
    list.ts           title derivation, search, export, fork

  settings/
    loader.ts         3-layer merge + hot-reload + system prompt composer
    memory.ts         CLAUDE.md / AGENTS.md project memory loader

  credentials/
    keychain.ts       macOS Keychain integration (security CLI)

  telemetry/
    telemetry.ts      error classification + usage tracking (5h window) + JSONL

  web/
    server.ts         HTTP + SSE server, multi-session, 14 endpoints

  sidequery/
    sideQuery.ts      non-streaming LLM call for internal ops (compression, classifier)

demo/
  settings.json       project-level config: permission rules + hooks + MCP
  hooks/prevent-rm.sh example PreToolUse hook
  web/index.html      single-page frontend (dark theme, sidebar, tool cards, modals)

test/
  smoke.js            156-unit engine regression suite (mock provider, no real API)
  web-smoke.js        39-unit Web/SSE regression suite
  mcp-server.js       minimal MCP echo server fixture

.github/workflows/ci.yml  CI: Node 20/22 matrix (check + lint + smoke + smoke:web)
eslint.config.js           flat config (@eslint/js + typescript-eslint, dev-only)
```

## Configuration

### Settings File (`settings.json`)

```jsonc
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep", "Bash(ls:*)"],
    "deny":  ["Bash(rm -rf:*)"],
    "ask":   []
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "./hooks/prevent-rm.sh" }
    ]
  },
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": ["test/mcp-server.js"]
    }
  },
  "engine": {
    "maxTurns": 200,
    "tokenBudget": 20000000
  },
  "model": "claude-sonnet-4-20250514",
  "systemPromptAppend": "Extra instructions appended to the system prompt."
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key (highest priority) |
| `ANTHROPIC_MODEL` | Model override (wins over settings) |
| `AGENT_HARNESS_HOME` | Redirect user-level config dir (default `~/.agent-harness`) |
| `AGENT_HARNESS_MOCK_SCRIPT` | Inject scripted MockProvider for deterministic tests |
| `AGENT_HARNESS_NO_KEYCHAIN` | Set `1` to disable Keychain lookup |
| `AUTH_TOKEN` | Fix Web server auth token (otherwise random per startup) |

## Development

```bash
npm run check       # type-check (tsc --noEmit)
npm run build       # compile to dist/
npm run lint        # eslint (flat config, dev-only)
npm run smoke       # 156-unit engine regression (no API key)
npm run smoke:web   # 39-unit Web/SSE regression (no API key)
```

CI runs `check` + `lint` + both smoke suites on a Node 20/22 matrix via GitHub Actions.

ESLint uses flat config (`@eslint/js` + `typescript-eslint` recommended sets) with repo-idiom relaxations: lazy `require` for cycle breaking, `no-explicit-any`, `_`-prefixed unused vars.

## Attribution

agent-harness is a reference implementation **inspired by Claude Code's architecture**. It is an independent reimplementation written from architectural study — no proprietary source code, tooling, or binaries were used in its construction.

## License

MIT
