# 第 12 项(新清单): TodoWrite 工具 + Web checklist 呈现

> 状态: 已实施完成(4 决策全按推荐获批: D1 全量替换 / D2 恢复最后快照 / D3 静态 allow 免弹窗 / D4 不动 demo 脚本; smoke 111/111 + web-smoke 33/33 + demo 24 轮回归通过)
> 前置: commit 18170e9 基线(smoke 106/106, web-smoke 32/32, demo 24 轮)
> 参照: Claude Code 核心工具 TodoWrite — 结构化任务清单, 模型自跟踪复杂任务, UI checklist 呈现

## 1. 现状审计

| 位置 | 现状 | 差距 |
|---|---|---|
| [src/tools/](../../src/tools/) | Bash/Read/Write/Edit/Glob/Grep/Task(只读 explore 单路派发) | 无 TodoWrite — Claude Code 核心工具集的最后缺口 |
| ToolContext([tool.ts](../../src/tools/tool.ts) L7-10) | 仅 signal | 纯内部状态工具无需扩展 ctx — 状态放工具实例内部即可 |
| createSession([cli.ts](../../src/cli.ts) L146-165) | 每会话独立 ToolRegistry + 新实例; TaskTool 以 DI 构造(`new TaskTool(createExploreAgent({...}))`) | TodoWriteTool 同款 DI 构造(emit/log 闭包注入) |
| UiEvent([events.ts](../../src/events.ts)) | 无 todos 事件; historyFromMessages 只回放消息块 | 需新增 `{kind:"todos"}` 全量快照事件; resume 回放补 todos |
| 权限瀑布([engine.ts](../../src/permissions/engine.ts) L105-109/L146) | 工具自身 checkPermissions 为静态层(allow 先记录待 Hook 审计); plan 门禁放行 static allow | TodoWrite.checkPermissions → static allow 即可(免弹窗 + plan 放行 + Hook 仍可拦) |
| CHAT_SYSTEM_PROMPT([cli.ts](../../src/cli.ts) L62-71) | 已有 Glob/Grep/Task/Edit 纪律段 | 无 TodoWrite 使用纪律 |
| onEvent([index.html](../../demo/web/index.html) L516+) | case 分发齐全, 无 todos 渲染 | 需 todos 面板(全量覆盖渲染) |
| /status([cli.ts](../../src/cli.ts) L524-528) | 轮次/tokens/错误/transcript | 无 todos 进度 |
| web-smoke(L456/L505/L652) | 独立 spawn 模式(独立 provider, mock 轮次从 1 起算, 不影响既有断言) | 新 e2e 照抄该模式 |
| transcript | tool_use/tool_result 本就入树(resume 重放) | 可扫最后一次 TodoWrite tool_use 重建状态 |

## 2. 设计提案

### A. 工具语义(Claude Code 对齐)

- 输入: `{ todos: [{ content: string, status: "pending" | "in_progress" | "completed", activeForm?: string }] }` — **全量替换**(每次调用给出完整清单, 非增量 patch)
- TodoWriteTool 实例内部持有 todos 状态(每会话独立实例 → 天然会话隔离, 无需全局 Map)
- status 非法值 → error result(列全部合法枚举, 与 validate.ts "详细错误一次给全" 同风格, 模型自修正)
- execute 返回摘要: 如 `todos 更新: 1/3 完成 | 进行中: 正在写测试` — 摘要回填 tool_result 进消息树
- 单一 in_progress 纪律: **提示层软约束, harness 不强制**(与 Claude Code 一致 — 提示纪律承担, 工具不报错)
- `checkPermissions` → `{ decision: "allow", reason: "内部任务状态, 无副作用" }`: 免弹窗; plan 模式亦放行(static allow 通过 plan 门禁); PreToolUse Hook 仍可拦(放行工具也过 Hook 审计, 引擎既有语义); 不产生会话记忆污染

### B. 事件与 UI

- UiEvent 新增 `{ kind: "todos"; todos: TodoItem[] }` — 全量快照, 前端 last-write-wins
- createSession 构造时注入闭包: `emit?.({kind:"todos"...})` + `log` 一行摘要(CLI 呈现)
- historyFromMessages: 扫消息树最后一次 TodoWrite tool_use → 追加 todos 快照事件(resume 后 Web 面板自动恢复)
- createSession resume 块: `todoTool.restoreFrom(repaired)` 从重放消息树恢复工具内部状态
- index.html: topbar 下 todos 面板(空清单/无事件时隐藏; ☐/◐/☑ 状态图标 + content, in_progress 高亮, activeForm 优先展示进行中项)
- headless `--output-format stream-json`: todos 事件随 UiEvent 流自动外发, 零改动

### C. 系统提示纪律(仅 CHAT 模式)

CHAT_SYSTEM_PROMPT 增加一段: ≥3 步任务先 TodoWrite 建清单; 恰好一个 in_progress; 随时更新(完成即标、新发现即追加); 全部完成后标尽。DEMO_SYSTEM_PROMPT 不动(mock 脚本不用该工具, 加了只会改 demo 水位计量)。

### D. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/tools/todowrite.ts` (新) | TodoWriteTool: 全量替换语义 + status 校验 + 内部状态 + restoreFrom + inputSchema |
| `src/events.ts` | UiEvent + todos 事件; TodoItem 类型; historyFromMessages 回放最后快照 |
| `src/cli.ts` | 注册(DI emit/log)+ resume 恢复 + CHAT 纪律段 + /status todos 进度行 |
| `demo/web/index.html` | todos 面板 + onEvent case |
| `test/smoke.js` | Part 16: 工具语义 5 例 |
| `test/web-smoke.js` | 新段独立 spawn e2e: todos SSE 事件 + 无 permission_request |
| `README.md` | 特性 bullet + 工具列表 + 计数 |

### E. 测试计划

smoke Part 16(5 例):
1. 全量替换: 两次 execute(3 项 → 2 项), `getTodos()` 以最后一次为准
2. status 非法值 → error result(含合法枚举提示, is_error)
3. checkPermissions → static allow; 经引擎在 plan 模式下仍放行(不弹窗不拒)
4. 摘要返回内容 + 空数组 = 清空清单
5. restoreFrom: 从含 TodoWrite tool_use 的消息树恢复状态 + historyFromMessages 追加 todos 快照事件

web-smoke(新段, 独立 spawn):
6. mock 脚本 TodoWrite 轮(`{ toolUses: [{ name: "TodoWrite", input: {...} }] }`)→ SSE 收到 todos 事件(内容匹配)→ 无 permission_request(静态免弹窗)

回归: check/build + smoke 106→111 + web-smoke 32→33 + demo 24 轮(demo 脚本不动, 零影响)。

## 3. 范围外(明确不做)

- demo 脚本加 TodoWrite 展示轮(除非决策 D4 选做 — 会改 24 轮基线, 须重数 mock 轮次)
- todos 跨会话持久化(transcript 之外的独立存储)
- 子代理(subagent)内独立 todo 上下文

## 4. 决策(AskUserQuestion — 已全部获批, 全按推荐)

| 决策 | 结论 |
|---|---|
| D1 语义 | **全量替换**(Claude Code 同款) |
| D2 resume | **恢复最后快照**(restoreFrom 逆向扫消息树) |
| D3 权限 | **静态 allow 免弹窗**(plan 模式亦放行, Hook 仍可审计) |
| D4 demo | **不动 demo 脚本**(保持 24 轮基线) |
