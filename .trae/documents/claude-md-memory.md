# 第 13 项: CLAUDE.md 项目记忆

> 状态: 已实施(D1-D4 全按推荐落地: 双层查找/段序 base→append→memory→cliAppend→modeSuffix/64K 截断/smoke Part 17 七例)
> 前置: commit e3e9f71 基线(smoke 111/111, web-smoke 33/33, demo 24 轮)
> 参照: Claude Code 核心特性 — 启动时读入 CLAUDE.md 项目记忆追加到系统提示, 跨会话的项目级指令持久化

## 1. 现状审计

| 接入点 | 现状 | 结论 |
|---|---|---|
| [loader.ts](../../src/settings/loader.ts) composeSystemPrompt L61-69 | `[base, systemPromptAppend, cliAppend, modeSuffix]` 四段拼接 | 加 `memory` 段位, 顺序见 D2 |
| resolveLayerPaths L44-52 | user(AGENT_HARNESS_HOME 可重定向)→ project(demo/)→ local(.agent-harness/) | 用户级目录已有重定向机制可复用 |
| 全仓 grep CLAUDE.md/AGENTS.md | 零命中 | 无任何 memory 文件支持 |
| cli.ts 三入口 | runDemo/runChat/runHeadless 各自 loadSettings + composeSystemPrompt | 三处接线 |
| [server.ts](../../src/web/server.ts) | 每会话创建时 loadSettings(会话级重读) | 同点接线, resume 亦重读(与 settings 一致) |
| loadMergedSettings | 职责单一(仅 settings.json), 字段级降级不 throw | memory 独立模块, 不混入 loader |

## 2. 设计提案

### A. 新模块 src/settings/memory.ts

```typescript
export interface MemorySource { path: string; chars: number; truncated: boolean; }
export interface ProjectMemory { text: string; sources: MemorySource[]; }
export function loadProjectMemory(opts?: {
  userDir?: string; projectRoot?: string; log?: (line: string) => void;
}): ProjectMemory
```

- 查找(序即拼接序, 见 D1): ①`<userDir>/CLAUDE.md` ②`<projectRoot>/CLAUDE.md` ③`<projectRoot>/AGENTS.md`(同级 fallback, 首个命中)
- 缺失 = 最常见形态, 静默跳过(同 settings 层语义); 读失败(权限等)警告不 throw
- 每文件软上限 64K chars(D3): 超限截断尾注 `…(已截断, 原文 N chars)` + log 警告
- 命中时 log: `[memory] <path>(N chars)`; 截断加注
- 返回拼接全文 + sources 诊断

### B. composeSystemPrompt 扩展(单一事实来源不变)

extra 加 `memory?: string`; 段序: `base → systemPromptAppend → memory → cliAppend → modeSuffix`(D2)。
memory 段带固定头 `以下是本项目 CLAUDE.md 项目记忆, 优先级高于一般偏好:`?— **不加头**, 纯内容拼接(头会污染 cache 前缀且无实证收益)。

### C. 接线点(4 处, 各一行)

- cli.ts runDemo / runChat / runHeadless: `loadSettings` 后 `loadProjectMemory(...)` → composeSystemPrompt 传 memory
- web/server.ts 会话创建点: 同上(每会话重读 — CLAUDE.md 热加载与 settings 热加载语义一致; 观察器仅监听 settings 层文件, 不扩)

## 3. 测试计划

- smoke Part 17(局部 require 模式): ①仅项目级 CLAUDE.md ②CLAUDE.md 缺失 → AGENTS.md fallback ③用户级+项目级级联拼接(序断言) ④64K 截断 + 尾注 ⑤全缺失 → 空串静默 ⑥composeSystemPrompt 段序断言(memory 在 append 后、cliAppend 前) ⑦AGENT_HARNESS_HOME 重定向生效
- demo 脚本零改动(24 轮基线保持)
- README: 特性 bullet + Layout 行 + smoke 计数 111→118

## 4. 决策(AskUserQuestion)

| 决策 | 待确认 |
|---|---|
| D1 查找范围 | 双层(用户级 AGENT_HARNESS_HOME + 项目级 CLAUDE.md→AGENTS.md fallback) vs 仅项目根 |
| D2 段序 | memory 在 settings 追加段之后(临时性递增: 配置→项目指令→会话临时) vs 紧跟内置基线 |
| D3 大小策略 | 每文件 64K chars 软上限截断+警告 vs 不设限 |
| D4 测试范围 | smoke 单测层(loadProjectMemory + composeSystemPrompt) vs 再加 web-smoke stderr `[memory]` 日志 e2e |

## 5. 范围外(不做)

- CLAUDE.md 递归父目录查找(Claude Code 有, 此处项目根即止)
- @import 语法/子文件引用展开
- memory 热加载 watcher(改 CLAUDE.md 下一会话生效即可)
- WebSearch/SessionStart hooks 等其余候选(后续项)
