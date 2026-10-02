# 第 9 项: 系统提示定制 + settings 分层合并(用户级 / 项目级 / 本地级)

## Context — 现状审计

| # | 现状 | 位置 | 问题 |
|---|------|------|------|
| 1 | settings 路径硬编码单文件 | [cli.ts:76](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L76) `SETTINGS_PATH = demo/settings.json`,缺失即 throw("请在仓库根目录运行") | 无用户级配置;换目录/换机器零配置迁移能力 |
| 2 | `loadSettings()` 单文件直读 | [cli.ts:78-101](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L78-L101) | 无合并逻辑;server.ts 经 re-export 复用同一路径 |
| 3 | 系统提示硬编码常量 | [cli.ts:47-63](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L47-L63) `DEMO_SYSTEM_PROMPT` / `CHAT_SYSTEM_PROMPT` | 用户/项目无法注入领域上下文(代码风格、技术栈、约束) |
| 4 | 子代理提示硬编码 | [subagent.ts:20-24](file:///Users/daqiao/Documents/workspace/claude-like/src/agent/subagent.ts#L20-L24) `SUB_SYSTEM_PROMPT` | 只读探索边界由代码保证 → **本项不动**(定制会破坏安全边界) |
| 5 | Plan 模式后缀 = 唯一"追加"先例 | [cli.ts:428-430](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L428-L430) 字符串拼接 | 证明"基线 + 追加段"组装方式可行 |
| 6 | model 仅 env 解析 | [cli.ts:407](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L407) `ANTHROPIC_MODEL ?? "claude-sonnet-4-5"` | settings 无 model 字段(用户级配置最常见的诉求之一) |
| 7 | 热加载仅 watch 单文件 | [cli.ts:256-272](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L256-L272) `fs.watch(SETTINGS_PATH)` → 规则+Hook 原地替换 | 分层后需 watch 全部已加载层 |
| 8 | `.agent-harness/` 已 gitignore | [.gitignore:4](file:///Users/daqiao/Documents/workspace/claude-like/.gitignore#L4) | 运行时目录 → 恰好可承载"本地个人覆盖"层(对标 `.claude/settings.local.json`);`demo/settings.json` 已提交 → 承载"项目共享"层 |

**规则引擎语义**(合并安全性的依据): `matchRule` 列表内 first-match,瀑布顺序 deny → ask → allow([rules.ts:130-137](file:///Users/daqiao/Documents/workspace/claude-like/src/permissions/rules.ts#L130-L137))→ 各层规则**并集**语义安全,deny 天然压过 allow(瀑布序保证),无需跨层去重。

## 设计提案

### 分层结构(对标 Claude Code: user → project → local → CLI/env)

| 层 | 路径 | 角色 | git |
|----|------|------|-----|
| 0 | 代码内置默认 | 全部字段的 fallback | — |
| 1 | `~/.agent-harness/settings.json`(env `AGENT_HARNESS_HOME` 可重定向) | 用户级: 跨项目偏好(model、常用 allow 规则、全局 systemPromptAppend) | 否 |
| 2 | `demo/settings.json`(**现有文件,零迁移**) | 项目级: 项目共享配置(现有字段全集不变) | 是 |
| 3 | `<PROJECT_ROOT>/.agent-harness/settings.json` | 本地级: 个人本地覆盖,对标 settings.local.json(临时调高 tokenBudget、个人 Hook) | 否(已 ignore) |
| 4 | env / CLI flags | `ANTHROPIC_MODEL`、`ANTHROPIC_API_KEY`、`chat --append-system-prompt "…"` | — |

> 层 2 保留 `demo/settings.json` 不迁移: 该文件已提交且被 demo 叙事依赖(hook 脚本 `demo/hooks/prevent-rm.sh`、MCP `test/mcp-server.js`);迁到 gitignored 的 `.agent-harness/` 会导致 fresh clone 后 demo 不可复现。新开仓库使用本 harness 时,项目级约定即"随仓库提交的 settings.json"。

### 合并语义(逐字段)

| 字段 | 合并方式 | 说明 |
|------|---------|------|
| `permissions.allow/deny/ask` | **并集**(按 1→3 层序 concat) | 瀑布序保证 deny 跨层压过 allow;列表内 first-match,顺序仅影响同列表前缀优先级(确定性: 深层靠后) |
| `hooks` | **按事件键连接数组**(用户先执行 → 项目 → 本地) | 合并原始对象后整体过 `parseHookSettings` |
| `mcpServers` | **按键覆盖**(同名 server: 深层整个 def 替换;异名: 并集) | 对标 Claude Code;server def 视为原子配置单元 |
| `engine.maxTurns/tokenBudget` | **标量深层覆盖** | 深层显式声明才覆盖(`undefined` 不覆盖) |
| `model`(新字段) | 标量深层覆盖;**env `ANTHROPIC_MODEL` 仍最高** | 解析序: env > 本地 > 项目 > 用户 > 内置默认 |
| `systemPromptAppend`(新字段) | **字符串拼接**(层 1 → 2 → 3 顺序,`\n\n` 连接) | 追加在内置基线之后;CLI `--append-system-prompt` 排最后 |

### 系统提示组装

```
内置基线(DEMO 或 CHAT,按模式)
  + systemPromptAppend(user → project → local)
  + --append-system-prompt(CLI)
  + 模式后缀(Plan 等,引擎注入,永远最后且不可被配置覆盖)
→ join("\n\n") → createSession({ systemPrompt })  // 现签名不变
```

- 三入口统一走 loader 的 `composeSystemPrompt()`: runDemo / runChat / server.activateSession
- `systemTokens` 由组装后全文重算(现有逻辑复用)
- MockProvider 忽略系统提示内容 → demo 脚本轮次零影响;`demo/settings.json` 不含新字段 → 现有全部回归的 token 计量零偏移

### 坏配置政策

| 情形 | 处理 |
|------|------|
| 层文件不存在 | 正常跳过(最常见形态,静默) |
| JSON 解析失败 | **警告日志 + 整层跳过**(其余层照常合并) |
| 字段类型不符(如 `permissions: "x"`) | **字段级降级**: 忽略该字段 + 警告(列出字段名/期望类型/实际值),其余字段照常 |
| 未知顶层字段 | 警告提示(前向兼容,不拒绝) |
| 全部层都不存在 | 提示一行(非 throw)——现有 loadSettings 的 throw 移除 |

> 字段级降级复用第 12 项 validate.ts 的"详细错误一次给全"风格: 一条警告列全部问题,不挤牙膏。

### 热加载(范围与现状一致)

- watch 对象从单文件 → **全部已加载层**(user/project/local 实际存在的文件)
- 热生效范围不变: 仅 `permissions.updateRules` + `hooks.updateSettings`
- systemPrompt / model / engine **不热加载**: CLI 长会话下个会话生效;web 端 activateSession 每次新会话重新 loadMergedSettings → 天然即时生效

## 设计决策

### 已从代码分析确定(不再另行讨论)

- **项目级 = 现有 `demo/settings.json`,不迁移**: 已提交 + demo 叙事依赖;`.agent-harness/settings.json` 作本地级层(对标 settings.local.json)
- **子代理 `SUB_SYSTEM_PROMPT` 不开放定制**: 只读边界(不可写/不可执行/不可嵌套)由提示文本承载,定制即破坏安全设计
- **模式后缀(Plan)永远最后**: 引擎行为约束不可被配置覆盖/绕过
- **`AGENT_HARNESS_HOME` 环境变量**: 重定向用户级目录(测试注入 + 非 macOS 可移植;与 `AGENT_HARNESS_NO_KEYCHAIN` 命名风格一致)
- **合并为纯函数**: `mergeSettings(layers: RawSettings[])` 可单测,文件 IO/路径解析与合并逻辑分离
- **server.ts 兼容**: cli.ts 继续导出 `loadSettings` 薄包装(内部转调 loader),server.ts 零改动即获分层能力

### ✅ 经 AskUserQuestion 确认(2026-10-02, 四项均按推荐通过)

1. **分层结构**: **三层** — user(`~/.agent-harness/settings.json`,env `AGENT_HARNESS_HOME` 可重定向) → project(现有 `demo/settings.json`,零迁移) → local(`<PROJECT_ROOT>/.agent-harness/settings.json`,gitignored);env/CLI 最高
2. **系统提示定制**: **append-only** — settings `systemPromptAppend` 字段(各层拼接)+ `chat --append-system-prompt` flag;保留内置基线纪律;模式后缀永远最后;不做整体替换、不做 CLAUDE.md 式文件
3. **坏配置政策**: **字段级降级 + 警告** — 字段类型不符忽略该字段+详细警告,其余照常;仅 JSON 解析失败才整层跳过
4. **model 入 settings**: **加入,env 优先** — 解析序 `ANTHROPIC_MODEL` env > settings(本地>项目>用户) > 内置默认

## 改动文件

### 1. 新增 `src/settings/loader.ts`(核心新模块,零依赖)

```ts
export interface RawSettings {           // 单层原始形态(全部可选)
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: unknown;
  mcpServers?: Record<string, McpServerConfig>;
  engine?: { maxTurns?: number; tokenBudget?: number };
  model?: string;
  systemPromptAppend?: string;
}
export interface MergedSettings {        // loadSettings 现返回形态的超集
  rules: PermissionRules;
  hookSettings: HookSettings;
  mcpServers: Record<string, McpServerConfig>;
  engine: { maxTurns?: number; tokenBudget?: number };
  model?: string;
  systemPromptAppend: string;            // 各层拼接结果
  layers: { path: string; loaded: boolean; warnings: string[] }[];  // 诊断信息
}
// 三层路径解析: AGENT_HARNESS_HOME ?? ~/.agent-harness → user;PROJECT_ROOT → project/local
export function resolveLayerPaths(opts?: { userDir?: string; projectRoot?: string }): string[]
// 纯函数合并(单测入口): 字段级降级在此实现,警告收集进 layers
export function mergeSettings(layers: RawSettings[]): MergedSettings
// 入口: 读文件(JSON 坏→整层跳过+警告)→ mergeSettings
export function loadMergedSettings(opts?: { userDir?: string; projectRoot?: string }): MergedSettings
// 系统提示组装: 基线 + append(merged) + cliAppend + 模式后缀
export function composeSystemPrompt(base: string, merged: MergedSettings, extra?: { cliAppend?: string; modeSuffix?: string }): string
```

### 2. 修改 [cli.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts)

- `loadSettings()` 改薄包装: `loadMergedSettings()` → 兽返回 MergedSettings(export 签名拓宽,server.ts 解构不变)
- `runDemo`/`runChat`: `systemPrompt: composeSystemPrompt(DEMO|CHAT_SYSTEM_PROMPT, merged)`;runChat 额外接 `--append-system-prompt` flag 与 `modeSuffix`(Plan)
- model 解析: `env > merged.model > 默认`(chat + web makeProvider)
- watcher: `fs.watch` 循环 `merged.layers` 中 loaded 的路径(去抖逻辑复用)

### 3. 修改 [web/server.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/web/server.ts)

- `activateSession`: `systemPrompt: composeSystemPrompt(CHAT_SYSTEM_PROMPT, merged)`;`makeProvider` 的 model 解析接入 merged.model(env 仍优先)

### 4. 不动

- `demo/settings.json`(字段零变化,新字段全部可选)
- subagent.ts、query.ts、permission 引擎(合并结果的数据形态与现状一致)

## 测试计划

- **smoke.js Part 11**(新增 ~8 例): `mergeSettings` 纯函数单测(并集/按键覆盖/标量覆盖/拼接顺序/字段级降级/未知字段警告/JSON 坏整层跳过/model 解析序)+ `resolveLayerPaths` 的 `AGENT_HARNESS_HOME` 重定向(临时目录 fixture)
- **web-smoke 测试 18**(新增 1 例 e2e): **独立 spawn server 实例**(独立端口 + `AGENT_HARNESS_HOME` 指向含 `Bash(date:*)` allow 规则的用户级 settings 临时目录)→ 发消息触发 date → 断言**无 permission_request 事件**(用户级规则跨层生效)→ 不触碰既有 17 个测试的轮次记账
- **README**: 新增"分层配置"一节(层级表 + 合并语义 + AGENT_HARNESS_HOME + systemPromptAppend/--append-system-prompt 用法);计数更新 smoke 67→75 / web-smoke 23→24
- **回归**: `npm run check && npm run build && node test/smoke.js && node test/web-smoke.js && npm run demo`

## 范围外(明确不做)

- CLAUDE.md / AGENTS.md 式项目上下文文件(递归父目录查找、大小上限、watch → 独立项)
- SUB_SYSTEM_PROMPT 定制(安全边界)
- 企业托管策略层(managed settings)
- `--setting key=value` 临时覆盖 flag
- settings schema 的 JSON Schema 文件化(手写字段校验足够,与 validate.ts 同风格)
