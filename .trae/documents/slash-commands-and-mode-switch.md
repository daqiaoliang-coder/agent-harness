# 第 7 项: Slash 命令 + 权限模式运行中切换

## Context — 现状审计

| # | 现状 | 位置 | 问题 |
|---|------|------|------|
| 1 | chat REPL 仅识别 `/exit`\|`exit` | [cli.ts:509-511](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L509-L511) `rl.on("line")` 内硬编码 | 无命令体系: 无帮助、无状态查看、无模式切换 |
| 2 | 权限模式会话创建时固定 | [cli.ts:444](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L444) `mode: planMode ? "plan" : "auto"` 传入后不可变 | 想临时切 Plan 规划 → 只能退出重启会话,丢失上下文 |
| 3 | `deps.mode` 消费点 3 处 | [engine.ts:86](file:///Users/daqiao/Documents/workspace/claude-like/src/permissions/engine.ts#L86)(plan 门禁)/ [L128](file:///Users/daqiao/Documents/workspace/claude-like/src/permissions/engine.ts#L128)(bypass 跳过)/ [L156](file:///Users/daqiao/Documents/workspace/claude-like/src/permissions/engine.ts#L156)(auto 分类器) | `updateRules` 热更新先例已有 → `updateMode` 可类比新增,纯内存态 |
| 4 | plan 模式引导仅靠系统提示后缀 | [cli.ts:433-437](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L433-L437) `composeSystemPrompt({modeSuffix})` 创建时烘入 | 运行中切走 plan 后模型仍受"只读规划"引导 → 语义不一致 |
| 5 | `deps.systemPrompt: string[]` 每轮主循环直读 | [query.ts:204](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts#L204) `buildRequest({system: deps.systemPrompt})` | 原地替换元素即生效,无缓存失效问题;`deps.systemTokens`(L91 水位计算)需同步重算 |
| 6 | Web 端模式为创建时快照 | [server.ts:75](file:///Users/daqiao/Documents/workspace/claude-like/src/web/server.ts#L75) `meta.mode` 仅展示于 ready/history;[index.html:166](file:///Users/daqiao/Documents/workspace/claude-like/demo/web/index.html#L166) topbar 徽章 | Web 无切换入口;slash 命令若前端直发 `POST /api/message` 会把命令文本发给 LLM |
| 7 | demo 全脚本驱动 | [cli.ts:278-312](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L278-L312) `buildScript()` | demo 不走 REPL → **本项零改动**(不动 mock 脚本轮次) |

## 设计提案

### 1. Slash 命令注册表(独立模块 `src/commands.ts`)

```
src/commands.ts
  interface CommandContext {
    getMode(): PermissionMode;
    setMode(mode: PermissionMode): void;        // 见 §2
    status(): string;                            // 轮次/累计 tokens/会话 id/transcript 路径
    permissionsSummary(): string;                // deny/ask/allow 规则计数 + 会话级记忆条数
    exit(): void;                                // CLI 传入(关 readline);Web 传 no-op
  }
  interface SlashCommand {
    name: string;                                 // "mode" → 用户输入 /mode
    description: string;                         // /help 列表用
    run(args: string, ctx: CommandContext): void;
  }
  const BUILTIN_COMMANDS: SlashCommand[] = [...]  // help / status / mode / permissions / exit
  export function dispatchSlashCommand(text, ctx): boolean
    // true = 已处理(是命令);false = 非命令(正常发给 LLM)
    // 未知 /xxx → 打印"未知命令(用 /help 查看)"并返回 true(防误发给 LLM)
```

命令集(按推荐方案 A):

| 命令 | 参数 | 行为 | CLI | Web |
|------|------|------|-----|-----|
| `/help` | — | 列出全部命令 + 当前模式 | ✓ | ✓ |
| `/status` | — | 轮次 / 累计计费 tokens / 会话 id / transcript 路径 / 错误次数 | ✓ | ✓ |
| `/mode` | 无参: 显示当前模式 + 可选值;有参: 切换 | 见 §2 | ✓ | ✓ |
| `/permissions` | — | deny/ask/allow 规则计数(分层合并后) + 会话级 always 记忆条数 | ✓ | ✓ |
| `/exit` | — | 退出(仅 CLI 有意义;Web 端注册为提示"直接关浏览器页即可") | ✓ | ✓ |

- **非命令兜底**: 以 `/` 开头但未注册 → 提示错误,**不发给 LLM**(对标 Claude Code 未知命令行为)。
- **调度点复用同一注册表**: CLI 在 `rl.on("line")` 的 `/exit` 处泛化为 `dispatchSlashCommand`;Web 在 `enqueueSend` 前拦截(`POST /api/message` 处理器内),命令输出经新 UiEvent 回流(见 §4)。

### 2. `/mode` 切换: 引擎 + 系统提示双通道即时生效

```
PermissionEngine.updateMode(mode): void        // 纯 deps.mode 替换(类比 updateRules)
Session.setMode(mode): void                    // cli.ts createSession 内新增,三步:
  ① permissions.updateMode(mode)
  ② 系统提示重组: prefix(基线+append+cliAppend) + (mode==="plan" ? PLAN_SUFFIX : "")
     → deps.systemPrompt = [重组文本]; deps.systemTokens = estimateTokens(重组文本)
  ③ log 提示 + emit({kind:"mode_changed", mode})   // Web 前端更新徽章
```

关键设计点:

- **plan 后缀动态化**: 后缀文本为常量(现 cli.ts:436 那句),来源唯一化——从 `runChat` 的 `composeSystemPrompt({modeSuffix})` 移入 createSession(新增可选参数 `modeSuffix` 不需要;直接在 Session 内部按目标模式决定)。切走 plan → 后缀移除,模型引导与权限门禁始终一致。
  - createSession 签名微调: `systemPrompt` 语义变为"前缀"(不含模式后缀);新增 `initialModeSuffix?: string`(resume 场景/向后兼容)。runChat 调用点改为: `composeSystemPrompt(CHAT_SYSTEM_PROMPT, merged, {cliAppend})` + `mode: planMode ? "plan" : "auto"` → createSession 内部追加后缀。demo/web 不传后缀 → 行为不变。
- **即时生效机制**: `deps.systemPrompt` 数组原地换元素 → 下一轮 LLM 调用即新提示;`systemTokens` 重算 → 水位检查同步正确。代价: 真实 provider 的 prompt cache 前缀失效一次(一次性成本,对标原版 /model 切换,可接受)。
- **切换到 `bypassPermissions` 需确认**: CLI 二次确认(y/N);Web 端该模式不出现在前端切换入口,仅显式 `/mode bypassPermissions` 命令 + 须带 `--dangerous` 后缀(`/mode bypassPermissions --dangerous`)才执行——防 token 泄露场景下 UI 误点即提权。其余模式(default/auto/plan)自由切换。

### 3. 模式语义(权限瀑布中的位置不变)

| 模式 | 瀑布行为 | 系统提示后缀 |
|------|---------|-------------|
| `default` | 无规则命中 → 用户弹窗(现状) | 无 |
| `auto` | 无规则命中 → LLM 两阶段分类器(现状) | 无 |
| `plan` | 只读白名单外一律拒(现状 L86 门禁) | "当前处于 Plan 模式: 只读探索与规划…" |
| `bypassPermissions` | 跳过全部确认(现状 L128) | 无 |

切换不清洗 `sessionAllows` 会话记忆(与 updateRules 热加载不清洗同理——用户明确授权过的操作不应因模式切换而失效;deny 规则/静态检查/Hook 均在记忆层之前,安全边界不受影响)。

### 4. Web 端联动

- **命令拦截**: `POST /api/message` 处理器内,`dispatchSlashCommand(text, webCtx)` 命中 → 不入 sendChain,命令输出经新事件回流。
- **新 UiEvent**: `{kind:"command_output"; text: string}`(命令结果,前端渲染为系统行)——比复用 `log`(前端默认折叠)可见性好。
- **模式切换 UI**: topbar `m-mode` 徽章改为 `<select>`(default/auto/plan 三项,bypass 不列)→ `POST /api/mode {mode, sessionId}`;server 调 `live.session.setMode()` → `mode_changed` 事件广播 → 前端徽章 + 其他标签页同步。
- `/api/session/history` 与 `/api/stats` 响应中 mode 改为实时值(`session.deps.permissions` 现取,不再用 meta 快照)。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/commands.ts`(新) | 命令注册表 + dispatchSlashCommand + PLAN_SUFFIX 常量 |
| `src/permissions/engine.ts` | `updateMode()` + `get mode()`(约 4 行) |
| `src/cli.ts` | Session 增 `setMode`;runChat 调用点后缀迁移;REPL 泛化 slash 调度;命令上下文实现 |
| `src/events.ts` | UiEvent 增 `command_output` / `mode_changed` |
| `src/web/server.ts` | /api/message 拦截命令 + 新 POST /api/mode + meta.mode 实时化 + web 命令上下文 |
| `demo/web/index.html` | 徽章改下拉 + 两个新事件渲染 |
| `test/smoke.js` | Part 12: 命令解析/updateMode 瀑布语义/setMode 提示重组(~8-10 例) |
| `test/web-smoke.js` | 测试 19: Web /mode 切换 e2e + command_output(需扩 WEB_MOCK_SCRIPT 并重数轮次) |
| `README.md` | 命令表 + 模式切换文档 |

## 测试计划

- **smoke Part 12**(纯内存单测,不碰 mock 脚本):
  1. dispatchSlashCommand: 已知命令/未知命令/非命令文本/带参解析
  2. `/mode` 无参显示、非法参数报错
  3. updateMode: plan 门禁即时生效(切前 allow → 切后 deny)/ auto 分类器路径启停 / bypass 跳过
  4. setMode: 系统提示含/不含 plan 后缀 + systemTokens 重算 + 切换不清洗 sessionAllows
  5. command_output / mode_changed 事件经 emit 外发(web 模式)
- **web-smoke 测试 19**(spawn 独立 server): POST /api/message 发 `/mode plan` → command_output + mode_changed 事件;follow-up Bash 非只读 → plan-mode 拒绝;`/mode auto` 切回 → 放行。**WEB_MOCK_SCRIPT 扩展须重数既有断言轮次**(MockProvider 按主循环 LLM 调用推进)。
- **全量回归**: check / build / smoke(76+新) / web-smoke(24+新) / demo 24 轮不变。

## 已确认决策(用户批准, 2026-10-02)

| # | 决策 | 结论 |
|---|------|------|
| ① | 命令集范围 | ✅ **标准 5 命令**: /help /status /mode /permissions /exit |
| ② | 切换即时性 | ✅ **双通道即时**: 权限引擎 + 系统提示同轮生效(plan 后缀动态增删) |
| ③ | Web 支持范围 | ✅ **全联动**: 命令拦截 + topbar 下拉 + /api/mode + 新事件 |
| ④ | plan 后缀语义 | ✅ **动态移除**: 单一事实来源 = 当前模式 |
