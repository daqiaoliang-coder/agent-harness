# agent-harness

AI coding agent harness — a minimal, self-contained implementation of the Claude Code architecture, built in TypeScript as a reference for studying agentic system design.

## Quick Start

```bash
npm install
npm run demo       # Mock provider, full pipeline walkthrough (no API key)
npm run web        # SSE + single-page UI on http://127.0.0.1:3218/?token=<printed-at-startup>
npm run chat       # Real LLM (key from env ANTHROPIC_API_KEY or macOS Keychain)

node dist/cli.js chat -p "summarize this repo" --output-format json   # headless single-shot (claude -p equivalent)
cat app.log | node dist/cli.js chat -p "find anomalies"               # stdin attached as extra context
cat prompt.txt | node dist/cli.js chat --output-format stream-json    # no -p: stdin is the prompt

node dist/cli.js key set|get|rm|status   # API key management via macOS Keychain (no plaintext .env)
```

## What It Is

A **zero-dependency** harness that exercises the full Claude-style agent loop:

- **Permission waterfall**: 8-layer deny → static check → hook → rule → classifier → user modal; the modal renders Edit/Write diff previews and offers session-scoped "always allow" that memorizes a prefix rule (`git push origin main` → `Bash(git push:*)`; compound commands remembered verbatim; tool-level for Edit/Write/MCP) — session memory overrides ask rules but never deny rules, static checks, or hooks
- **Tool input validation**: dispatch-layer shape check against each tool's `inputSchema` (required fields + strict `typeof`, no silent coercion) *before* the permission waterfall — a malformed `tool_use` never executes, never prompts, and returns a single self-correctable error listing every issue, unknown fields, and the full parameter signature; semantic guards inside tools (empty command, `timeout` 1–600000ms, `max_turns` 1–50, empty path) protect direct calls too, and "missing" is always distinguished from "explicitly empty" (empty `new_string` is a legitimate deletion); covers built-in tools, MCP tools, and Task subagents; failures counted in telemetry like unknown tools
- **Context compression pipeline**: T0 tool result budget → T1 micro → T2 snip → T3 collapse → T4 auto → T5 reactive (413 recovery)
- **Prompt cache multi-breakpoints**: three `cache_control` breakpoints in the real request body — system last block, tools array tail, and a message-history stable boundary; any compression layer that rewrites the tree (T2 snip / T3 collapse / T4 auto / T5 reactive) resets the boundary to the new tail, so everything before it is a stable prefix whose KV cache is reusable across turns; the mock pipeline mirrors this with two-segment fingerprints (`p1` = system+tools, `p2` = message prefix up to the boundary), logged per turn as `[cache] HIT/MISS p1/p2`
- **Streaming + tool-use parallelism**: full LLM streaming with `completeStream` and a three-stage retry matrix — connect-phase network errors, retriable non-200 (408/409/429/5xx/529), and mid-stream drops *before any delta is rendered* are retried with exponential backoff+jitter (request bytes identical, so the cache prefix still hits); once a delta has been rendered, a drop fails the turn cleanly with partial text kept on screen, never re-streamed; parallel tool execution with a concurrency cap and per-file edit mutex (no lost updates, no resource exhaustion)
- **Cooperative abort**: `AbortSignal` threaded through LLM fetch → tools → compact side queries → permission waits; aborted turns keep the message tree consistent (every `tool_use` gets a paired `tool_result`)
- **Crash-safe sessions**: transcript crash repair on `--resume` (orphaned `tool_use` gets a synthetic error result persisted; orphaned `tool_result` dropped) — a crashed session always reopens
- **Budget guard**: configurable `maxTurns` + session-wide token budget circuit breaker (`settings.json` `engine` section) so a runaway loop can't burn tokens unchecked
- **Layered settings + customizable system prompt**: Claude Code-style merge — user (`~/.agent-harness/settings.json`, redirectable via `AGENT_HARNESS_HOME`) → project (`demo/settings.json`, committed) → local (`.agent-harness/settings.json`, gitignored like `settings.local.json`) → env/CLI; permissions union, hooks concat per event, `mcpServers` per-key override, `engine`/`model` scalar override (`ANTHROPIC_MODEL` env still wins); system prompt is append-only: `systemPromptAppend` at any layer + `chat --append-system-prompt "…"` on top of the built-in baseline (mode suffixes like Plan always last); a malformed field degrades to a warning (that field is skipped, the rest merges), only a broken JSON file skips the whole layer — never a hard failure
- **CLAUDE.md project memory**: Claude Code-style persistent project instructions — at session start (every CLI entry and every Web session) the harness loads `<userDir>/CLAUDE.md` (user level, redirectable via `AGENT_HARNESS_HOME`) plus `<projectRoot>/CLAUDE.md` falling back to `AGENTS.md` (same dir, first hit wins), concatenates user-first, and injects the text between the settings append section and the CLI append (full order: built-in baseline → `systemPromptAppend` → memory → `--append-system-prompt` → mode suffix); missing files are the common case and stay silent, read failures warn without throwing, each file is soft-capped at 64K chars (truncated with a tail note), every hit logs `[memory] <path>(N chars)`, no header is prepended (cache prefix stays stable); reloaded per session like settings — no watcher, an edited file applies to the next session; recursive parent lookup and `@import` expansion are intentionally out of scope
- **Slash commands + runtime mode switch**: one shared registry (`/help` `/status` `/mode` `/permissions` `/usage` `/exit`) behind both the chat REPL and the Web input box — commands are intercepted before the LLM (unknown `/xxx` errors out instead of being sent to the model, and never enter the message tree); `/mode default|auto|plan|bypassPermissions` switches the permission waterfall mid-session with both channels taking effect on the next LLM call: the engine gate itself plus the system prompt (the Plan-mode suffix is added/removed dynamically, single source of truth = current mode); switching never wipes session "always allow" memory (deny/static/hooks still precede it); `bypassPermissions` requires an explicit `--dangerous` confirm and is never exposed in the Web dropdown (`POST /api/mode` rejects it with 400); the Web topbar badge is a live mode dropdown, `mode_changed`/`command_output` SSE events keep every tab in sync
- **Headless single-shot mode**: `chat -p "query"` (Claude Code `-p` equivalent) for scripts/CI — stdin pipe support (`cat log | chat -p "summarize"` attaches stdin as additional context; bare `cat prompt | chat` treats stdin as the prompt); `--output-format text|json|stream-json` (a single JSON object with result/session/turns/tokens/denials stats, or one-JSONL-per-line UiEvent stream ending in a `result` line); stdout stays pure (all progress logs go to stderr, safe to pipe); unattended permissions — the waterfall (deny/static/hooks/allow/classifier) runs as usual, anything that would prompt is auto-denied with a counter and the model sees the denial and can change course; `--permission-mode` sets the mode at startup since `/mode` can't run mid-shot (`bypassPermissions` still requires `--dangerous`); exit 0 = run completed (denials/tool errors are business results) / 1 = system fault / 130 = forced quit; sessions share the `sess_chat_*` namespace, so a headless run is resumable interactively and vice versa; `AGENT_HARNESS_MOCK_SCRIPT` env injects a scripted MockProvider for deterministic tests (explicit opt-in, never a silent fallback)
- **Credential management**: API key stored in the macOS Keychain via the `key` subcommand (`security` CLI, zero deps); resolution order `ANTHROPIC_API_KEY` env → Keychain → mock/demo mode
- **TodoWrite task list**: full-replacement todo list (each call passes the complete list, Claude Code semantics; a single `in_progress` item is prompt-layer discipline the harness does not enforce) held per-session inside the tool instance; statically allowed in the permission waterfall (no modal, passes even in plan mode, PreToolUse hooks can still audit); every write emits a `todos` SSE snapshot rendered as a Web panel (☐/◐/☑, `activeForm` shown while in progress, hidden when empty); `--resume` restores the last successful list from the transcript and history replay appends the snapshot event; `/status` shows per-status counts
- **WebSearch tool**: client-side web search wired like every other built-in tool (registry → permission waterfall → main loop → abort); statically allowed as a read-only network op — no modal, passes in plan mode, deny rules and PreToolUse hooks still intercept at earlier waterfall layers; default backend is DuckDuckGo's HTML endpoint (zero-key: `uddg=` redirect decoding, tag/entity stripping) behind an injectable `SearchFn` so unit tests fake the backend and never touch the network; `{query, max_results? 1–10}` with out-of-range values rejected, not clamped (Bash-timeout precedent); fixed 15s timeout, mid-search abort resolves `[aborted by user]` (Bash semantics), 16K-char hard output cap with truncation note; results render as numbered title/url/snippet lines with a source-count tail, and the generic Web tool card picks the `query` field up with zero frontend changes; the explore subagent stays offline by design
- **WebFetch tool**: fetch-and-read for URLs — `{url, max_chars? 1K–100K (default 32K)}` returns readable text: HTML goes through an exported pure `htmlToText` (script/style/comment stripping, block-tag line breaks, entity decoding, whitespace folding), JSON/plain text pass through untouched so the model can parse structure; SSRF guard is a pragmatic two-check design — entry URL must be http/https with a hostname blacklist (loopback/private/link-local/metadata, incl. `169.254.169.254` and `metadata.google.internal`), and because `fetch` follows redirects the *final* URL (`res.url`) is re-validated after the hop (metadata endpoints usually sit behind a 30x); known limit, stated not hidden: hostname-based checks don't stop DNS rebinding or decimal-IP literals; statically allowed like WebSearch (deny rules/hooks still intercept), 15s fixed timeout, abort → `[aborted by user]`, truncation tail note, `FetchFn` injectable so tests never touch the network
- **Multi-edit (Edit `edits[]`)**: the retired MultiEdit semantics folded into Edit — pass `edits: [{old_string, new_string, replace_all?}]` instead of the single pair (mixing both is an error); edits apply **sequentially** (each edit matches against the evolving content, so a later edit can target an earlier edit's output) and land **atomically**: the first failing edit (not-found / ambiguous / identical strings) aborts the whole call with the failing index — nothing is written, so a half-applied batch can never reach disk; per-edit `replace_all` overrides the top-level flag; the permission modal preview runs the *same* exported `applyEdits` pure function (modal shows exactly what execution will do, failure notes included) and still never touches fileState; single-edit mode keeps its exact legacy behavior and error strings
- **Web UI, multi-session**: native SSE server + single-page frontend with tool cards, permission modals, session resume, stop button; multiple concurrent sessions (per-session serial queue, LRU cap 8, per-session abort), all SSE events tagged with `sessionId` so multiple tabs can watch different sessions; loopback-bound with startup token auth (all endpoints, incl. SSE/static page)
- **Error telemetry**: engine-level exceptions classified (provider/budget/compact/hook/engine) and appended to `.agent-harness/telemetry/errors.jsonl`; tool-level failures counted; user aborts never counted as errors; exposed via `GET /api/stats` (Web) and an exit summary (chat)
- **Usage dashboard**: every billable LLM call (input/output + cache read/write) is appended to `.agent-harness/telemetry/usage.jsonl` and aggregated over a rolling **5-hour window**; the same numbers feed three surfaces — a per-turn `usage` SSE event (turn-entry watermark snapshot: buffer vs effectiveWindow plus autoCompact/warning/blocking thresholds) driving the Web topbar context gauge, `GET /api/usage` (window totals + per-live-session usage, polled every 30s), and the `/usage` slash command; the MockProvider synthesizes `estimateTokens`-based usage so the mock/demo pipeline exercises the same dashboard end-to-end
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
  permissions/      8-layer waterfall + diff preview + session always-memory + rules + static checks + classifier
  compact/          T0 budget · T1 micro · T2 snip · T3 collapse · T4 auto · T5 reactive
  context/          prompt cache boundary + token estimator
  hooks/            hook runner + event registry
  commands.ts       slash command registry (shared by chat REPL + Web) + runtime mode switch
  tools/            Bash Read Write Edit(single+multi) Glob Grep TodoWrite WebSearch WebFetch Task + ToolRegistry + input validation
  llm/              MockProvider (scripted) + AnthropicProvider (zero-dep fetch)
  mcp/              stdio JSON-RPC server/client
  agent/            read-only explore subagent (independent context)
  session/          transcript resume
  settings/         layered settings loader (user → project → local) + system prompt composer + CLAUDE.md project memory
  credentials/      API key management (macOS Keychain via security CLI)
  telemetry/        error classification + usage tracking (5h window) + JSONL logs + stats
  web/server.ts     SSE server, multi-session (no deps)
demo/
  web/index.html    single-page frontend
  settings.json     project-level settings: permission rules + hooks + MCP servers
test/
  smoke.js          136-unit engine regression (no real API; incl. streaming-retry e2e via fake SSE server with mid-stream cut + cache multi-breakpoint e2e + headless -p / stdin / output-format e2e + usage window/event e2e + TodoWrite todo-list e2e + CLAUDE.md project-memory lookup/cascade/truncation units + WebSearch injectable-backend units + WebFetch SSRF/htmlToText/abort units + Edit multi-edit atomicity/preview units)
  web-smoke.js      33-unit Web/SSE regression (auth + abort e2e + multi-session + telemetry + permission always e2e + input validation e2e + layered-settings e2e + slash-commands/mode-switch e2e + usage-dashboard e2e + todo-list e2e via AGENT_HARNESS_MOCK_SCRIPT, no real API)
```

## Attribution

agent-harness is a reference implementation **inspired by Claude Code's architecture**. It is an independent reimplementation written from architectural study — no proprietary source code, tooling, or binaries were used in its construction.

## License

MIT
