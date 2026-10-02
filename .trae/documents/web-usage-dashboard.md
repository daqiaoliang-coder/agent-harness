# 第 10 项: Web 用量仪表盘(水位条 + 5h 窗口 + /usage 命令)

## Context — 现状审计

| # | 现状 | 位置 | 问题 |
|---|------|------|------|
| 1 | 引擎每轮有 buffer tokens 数据但只走 log 文本 | [query.ts:216-219](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts#L216-L219) `[loop] turn N \| buffer X tokens (Y% of effectiveWindow)` | 前端只能当纯文本日志显示(`show-log` 勾选), 无法渲染结构化水位条 |
| 2 | 用量累计仅会话内存态 | [query.ts:234-244](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts#L234-L244) `state.totalTokensUsed`(计费全口径: in+out+cache 读写) | 进程重启即失;无跨会话/跨时间聚合 → 5h 窗口无从谈起 |
| 3 | 遥测只有错误维度 | [telemetry.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/telemetry/telemetry.ts) errors.jsonl + 计数;`/api/stats` 已带 liveSessions turns/tokensUsed 快照 | 无 usage 历史落盘,无窗口聚合接口 |
| 4 | 水位阈值已算好但前端不可见 | [watermarks.ts:74-84](file:///Users/daqiao/Documents/workspace/claude-like/src/compact/watermarks.ts#L74-L84) `computeWatermarks` → effectiveWindow/autoCompactAt/warningAt/blockingAt | T0-T5 触发对用户是黑盒,看不到"还剩多少上下文" |
| 5 | MockProvider 不返回 usage | [provider.ts:138-140](file:///Users/daqiao/Documents/workspace/claude-like/src/llm/provider.ts#L138-L140) `this.text()` 无 usage 字段 | mock 模式下仪表盘无数据可显,5h 窗口 e2e 不可测 |
| 6 | Web topbar 仅 model/perm/session/conn 徽章 | [index.html:170-174](file:///Users/daqiao/Documents/workspace/claude-like/demo/web/index.html#L170-L174) | 无用量/水位展示位 |
| 7 | 既有断言不依赖 tokensUsed=0 | smoke.js 仅 2 处引用 totalTokensUsed(L719 stub provider 预算测试 / L1693 headless typeof) | Mock 注入合成 usage 对既有测试零破坏(已验证) |

## 设计提案

### 1. 新 UiEvent `usage`(每主循环轮一推, 水位条数据源)

```
| { kind: "usage"; turn: number; bufferTokens: number; totalTokensUsed: number;
    tokenBudget?: number;
    watermarks: { effectiveWindow; autoCompactAt; warningAt; blockingAt } }
```

- 发射点: [query.ts:216](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts#L216) `[loop] turn` 日志旁(轮入口快照)——buffer 为本轮请求的上下文规模, totals 为截至上一轮的累计;水位于 T4 压缩后下一轮事件自然回落。
- 前端: `handleEvent` 新增 case → 更新 topbar 迷你水位条(60px 进度条 + 百分比), 颜色分区: `<autoCompactAt` 正常 / `≥autoCompactAt` 警告(T4 即将介入)/ `≥blockingAt` 危险。
- Mock 模式照发(bufferTokens 由 estimateTokens 计算, 与 provider 无关)。

### 2. Telemetry 扩展: `recordUsage` + usage.jsonl + 5h 滚动窗口聚合

```
Telemetry.recordUsage(sessionId, {input, output, cacheRead, cacheCreate})
  → 内存 push {ts, sessionId, …} + 追加 .agent-harness/telemetry/usage.jsonl
Telemetry.usageStats(windowMs = 5h)
  → { since(窗口内最早 ts), calls, sessions, totals: {input, output, cacheRead, cacheCreate, total} }
```

- 记录点: query.ts usage 累计处(真实 provider 有 usage 时)——与 `[usage]` 日志同源。
- 窗口语义: **滚动 5h**(每次调用带 ts, 聚合最近 5h 全部记录;无块状态机);进程生命周期聚合(与错误计数一致, `since` 为进程启动), JSONL 落盘供离线分析。

### 3. `GET /api/usage`(5h 窗口聚合端点)

```json
{ "since": "...", "windowMs": 18000000, "calls": 12, "sessions": 2,
  "totals": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreate": 0, "total": 0 },
  "liveSessions": [{ "id": "...", "turns": 3, "tokensUsed": 1234 }] }
```

前端 topbar `5h ▮ N` 徽章: 30s 轮询 + stop 事件触发刷新;title 悬浮显示 input/output/cache 分解;点击 → sysLine 打印明细(含各活动会话用量)。

### 4. MockProvider 注入合成 usage(决策①)

- 主轮次返回 `usage = { input_tokens: estimateTokens(system+messages), output_tokens: estimateTokens(本轮内容), cache 0 }`;侧查询不计(与真实侧查询不进 totalTokensUsed 的现状口径一致)。
- 效果: mock 模式仪表盘/5h 徽章有真实感数据, web-smoke 可 e2e 断言 totals>0;demo 模式 `[usage]` 日志照常出现。

### 5. `/usage` slash 命令(决策④, CLI/Web 双端对称)

- `BUILTIN_COMMANDS` 新增: 输出 5h 窗口 totals 分解 + 活动会话各自 tokensUsed;`CommandContext` 增 `usageSummary(): string`(CLI 走 telemetry;Web 命令桥接同源)。
- 不入消息树/不消耗 mock 轮次(与既有命令拦截同路径)。

## 涉及文件

| 文件 | 改动 |
|------|------|
| [src/events.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/events.ts) | UiEvent 新增 `usage` 变体 |
| [src/query.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts) | 轮入口 emit usage 事件;usage 累计处 `telemetry.recordUsage` |
| [src/telemetry/telemetry.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/telemetry/telemetry.ts) | recordUsage + usage.jsonl + usageStats(windowMs) |
| [src/llm/provider.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/llm/provider.ts) | Mock 主轮合成 usage(决策①通过时) |
| [src/web/server.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/web/server.ts) | GET /api/usage;webCommandCtx 接 usageSummary |
| [src/commands.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/commands.ts) | /usage 注册 + CommandContext.usageSummary |
| [src/cli.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts) | CLI 命令 ctx 接 telemetry.usageStats |
| [demo/web/index.html](file:///Users/daqiao/Documents/workspace/claude-like/demo/web/index.html) | topbar 水位条 + 5h 徽章;usage case;30s 轮询 |
| [test/smoke.js](file:///Users/daqiao/Documents/workspace/claude-like/test/smoke.js) | Part 14 新增 ~4 例 |
| [test/web-smoke.js](file:///Users/daqiao/Documents/workspace/claude-like/test/web-smoke.js) | 新段 ~3 例(新会话重置 mock 脚本, 不影响既有轮次) |
| [README.md](file:///Users/daqiao/Documents/workspace/claude-like/README.md) | 特性 + 计数 |

## 测试计划

**smoke Part 14(~4 例)**:
1. Telemetry.recordUsage + usageStats: 注入不同 ts 的记录 → 5h 内聚合/5h 外剔除;calls/sessions/totals 字段
2. runQuery + stub provider → usage 事件发射: turn/bufferTokens/watermarks 字段齐(每轮一推)
3. MockProvider 主轮返回合成 usage(非零, 侧查询不计)
4. /usage 命令: fake ctx 输出含 5h 分解;未知命令路径不受影响

**web-smoke 新段(~3 例, 主实例新会话 → mock 脚本重置)**:
1. 新会话发消息 → SSE 收到 ≥2 个 usage 事件(tagged sessionId, bufferTokens>0, watermarks 齐)
2. GET /api/usage: mock 合成 usage 后 totals.total>0 + 形状断言
3. /usage 命令 e2e: POST /api/message → command_output 事件含窗口分解(不入消息树)

**回归**: check/build + smoke 91→95 + web-smoke 29→32 + demo 24 轮不变 + README 计数。

## 待确认决策

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| ① | Mock 合成 usage | 注入(mock 仪表盘有数据、5h e2e 可测;既有断言零依赖已验证) | 不注入(5h 仅真实 key 有意义, 测试只验形状) |
| ② | 5h 窗口语义 | 滚动窗口(每调用带 ts, 聚合最近 5h;无块状态机) | 固定 5h 块(更贴近 Claude Code 订阅块, 但本地无服务端对账, 状态机复杂) |
| ③ | 前端刷新通道 | usage SSE 事件(水位条实时) + /api/usage 30s 轮询(5h 聚合) | 纯轮询(实现最省, 水位条滞后 ≤30s) |
| ④ | CLI 对称 /usage 命令 | 加(registry 现成, CLI/Web 双端一致) | 仅 Web 徽章(不加命令) |
