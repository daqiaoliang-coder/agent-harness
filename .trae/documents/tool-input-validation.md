# 第 12 项:工具输入校验(调度层形状校验前置 + 工具内语义修正)

## Context

LLM 生成的 `tool_use.input` 目前由各工具内部 `String(x ?? "")` / `Number(x)` 宽松转换消化,坏输入被静默吞掉——错误要么延迟到运行期才以困惑的形式暴露,要么直接造成数据丢失。源码审计发现的真实缺口(按严重度):

| # | 工具 | 现状行为 | 危害 |
|---|------|---------|------|
| 1 | Write | `content` 缺失 → `String(undefined) = ""` → **静默清空已存在的文件**(writeFileSync 覆写空串) | 数据丢失 |
| 2 | Edit | `new_string` 缺失 → 转空串 → old_string 非空时**静默删除匹配内容** | 数据丢失 |
| 3 | Bash | `timeout: "abc"` → `Number()` = NaN → `setTimeout(NaN)` 视作 0 → **命令被立即 kill**;负数同理 | 假超时行为 |
| 4 | Bash | `command` 缺失/空串 → `bash -c ""` exit 0 空输出,**静默成功** | 假成功 |
| 5 | Task | `max_turns: "abc"` → NaN → `\|\| 12` 静默回退;负数 → 子代理 0 轮,抛"超过最大轮次守卫(-5 轮)" | 困惑错误 |
| 6 | Grep | `max_results: -10` → `lines.length < -10` 恒 false → 返回假"未找到匹配" | 假结果 |
| 7 | Read/Write | 空 `path` → `path.resolve("")` = cwd → 抛困惑的 ENOENT("读取失败: no such file or directory, open ''") | 低质量报错 |
| 8 | 全部工具 | 非字符串静默转换:`path: 123` → String() → "123" 错路径;`replace_all: "true"`(字符串) → `=== true` 静默当 false | 静默错行为 |

**双层设计**(形状 vs 语义分开,职责清晰):
- **形状校验(新增,调度层统一前置)**: 按 `inputSchema` 查必填缺失/类型不符 → 失败即 isError tool_result(模型下一轮自修正),**不执行、不进权限瀑布、不跑 PostToolUse**
- **语义修正(工具 execute 内)**: "形状合法但值无意义"(空串、越界数值)留在工具内——直调 `execute` 的调用方(测试/未来 SDK)同样受保护

## 设计决策

### 已从代码分析确定(不再另行讨论)

- **挂载点 = [query.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts) `runOne`**: 未知工具检查之后、权限瀑布之前。理由:
  1. 单点覆盖**全部内置工具 + MCP 工具**(`McpTool.inputSchema` 来自 server def)+ **Task 子代理**(子代理走同一 `runQuery`,见 [subagent.ts:84](file:///Users/daqiao/Documents/workspace/claude-like/src/agent/subagent.ts#L84))
  2. 垃圾输入不值得浪费弹窗/分类器/Hook——`checkBashCommand(String(command))` 与 `deriveAlwaysRule` 都假设字段是 string,先拦垃圾输入可避免从 `command: null` 派生出 `Bash(null:*)` 这类错误前缀记忆
  3. PreToolUse Hook 在瀑布内部 → Hook 看不到垃圾输入(可接受:Hook 是策略层,不是垃圾过滤器)
  4. 校验失败的 tool_result 经现有 `results.forEach` emit 路径自动外发 → web 前端错误卡片零改动
- **未知字段不拒绝**(前向兼容;Anthropic tool_use 正常不产生),但**校验失败文案尾部列出未知字段名**——模型把 `path` 幻觉成 `file_path`(Claude Code 习惯)时能立即对上正确参数名
- **错误文案一次给全**: 所有字段问题 + 完整参数签名(字段名/类型/必填),单轮自修正成功率高,不挤牙膏
- **不抛异常**: 校验失败以 `is_error: true` tool_result 入消息树(与未知工具/权限拒绝同风格,保证 tool_use 配对完整——项目硬约束)
- **数值下界只查 `> 0` 不设最小值**: smoke.js Part 6 的 Bash 中断测试可能用短 timeout,下界过高会破坏既有测试

### ✅ 经 AskUserQuestion 确认(2026-10-02, 四项均按推荐通过)

1. **遥测口径**: 校验失败**计入** `toolErrors`(与"未知工具"同级,均为模型坏调用,现有口径已计入未知工具)
2. **类型严格度**: **严格 typeof**(声明 string 收到 number → 拒;"30000" 字符串 timeout → 拒)
3. **数值越界政策**: Bash timeout / Task max_turns / Grep max_results 越界 → **报错**(文案含合法区间;clamp 会让模型误以为自己的值生效)
4. **路径范围**: **本项不限制**(路径边界属权限模型:写类已走弹窗、读类静态放行是既有设计;混入会扩大改动面)

## 改动文件

### 1. 新增 `src/tools/validate.ts`(核心新模块,零依赖)

```ts
export interface ValidationIssue { field: string; problem: string }
// 校验: input 是否满足 schema 的 required + 声明类型(手写 JSON Schema 子集, 不引第三方库)
export function validateToolInput(schema: Record<string, unknown>, input: unknown): ValidationIssue[]
// 组装 tool_result 文案: 头行(工具名) + 逐字段问题 + 未知字段提示 + 参数签名摘要
export function formatValidationIssues(toolName: string, schema: Record<string, unknown>, issues: ValidationIssue[]): string
```

**validateToolInput 逻辑**:
- input 非 plain object(`typeof !== "object"` / `null` / `Array.isArray`)→ 单条 `(input)` 问题,直接返回
- 遍历 `schema.required`: 值为 `undefined`/`null` → "必填字段缺失";再对已存在值做声明类型检查
- 遍历 `Object.keys(input)`: 字段在 `properties` 中且声明了 `type` → 严格类型检查;不在 `properties` → 计入未知字段(仅文案提示,**不产生 issue、不拒绝**)
- 类型检查严格对照: `"string"` → `typeof === "string"`;`"number"` → `typeof === "number" && Number.isFinite`;`"integer"` → `Number.isInteger`;`"boolean"` → `typeof === "boolean"`;`"object"`/`"array"` → typeof/Array.isArray;**未声明 `type` 或复杂形状(anyOf 等,MCP schema 可能出现)→ 跳过类型检查**(best-effort,required 照查)

**文案示例**(Write 缺 content + 幻觉字段):
```
工具输入校验失败(Write): content: 必填字段缺失。未知字段: cotnent(不在该工具 schema 中)。
参数 schema: path: string(必填), content: string(必填)
```

### 2. 修改 [query.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/query.ts#L307-L311)(`runOne`,未知工具检查后、`try` 内权限瀑布前插入)

```ts
const tool = deps.tools.get(tu.name);
if (!tool) { ...现状不变... }
// 形状校验前置: 垃圾输入不进瀑布/不弹窗/不派生错误记忆规则
const issues = validateToolInput(tool.inputSchema, tu.input);
if (issues.length > 0) {
  deps.telemetry?.recordToolError(); // ⏳ 口径 1: 推荐计入(同未知工具)
  deps.log(`[validate] ${tu.name} 输入校验失败: ${issues.map(i => `${i.field}: ${i.problem}`).join("; ")}`);
  return { type: "tool_result", tool_use_id: tu.id, content: formatValidationIssues(tu.name, tool.inputSchema, issues), is_error: true };
}
// 权限瀑布(现状不动)...
```

- PostToolUse Hook 不跑(工具未执行,与权限拒绝路径一致);`tool_start`/`tool_result` emit 走现有统一路径

### 3. 修改 [bash.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/tools/bash.ts#L26-L28)(语义修正)

```ts
const command = String(input.command ?? "");
const rawTimeout = input.timeout; // validator 已保证 number(若传)
if (!command.trim()) return { content: "参数错误: command 不能为空", isError: true };
if (rawTimeout !== undefined) {
  const t = Number(rawTimeout);
  if (!Number.isFinite(t) || t <= 0 || t > 600_000)
    return { content: `参数错误: timeout 须为 1-600000 ms(收到 ${JSON.stringify(rawTimeout)})`, isError: true }; // ⏳ 口径 3
}
const timeout = rawTimeout !== undefined ? Number(rawTimeout) : EXEC_TIMEOUT_MS;
```

(上界 600_000 = 10 分钟,对齐 Claude Code 惯例)

### 4. 修改 [task.ts](file:////Users/daqiao/Documents/workspace/claude-like/src/tools/task.ts#L33)(语义修正)

`max_turns` 越界(NaN 保险/`< 1`/`> 50`)→ 报错文案含合法区间(⏳ 口径 3;现有 `Math.min(n, 50)` 上界 clamp 与 `|| 12` NaN 兜底移除,改为显式检查——NaN 由 validator 拦,此处直调保险)

### 5. 修改 [grep.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/tools/grep.ts#L43)(语义修正)

`max_results` 传了但 `< 1` 或非整数 → 报错(⏳ 口径 3);`> 500` 维持现有 clamp(上界是展示截断而非语义错误,不破坏现有行为)

### 6. 修改 [write.ts](file:////Users/daqiao/Documents/workspace/claude-like/src/tools/write.ts#L30-L37) / [read.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/tools/read.ts#L25-L27)(语义修正 + 直调防线)

- `!p` → `"参数错误: path 不能为空"`(替换困惑的 ENOENT)
- write.ts 增加直调防线:`typeof input.content !== "string"` → 报错"content 必须为 string"(**直调 execute 绕过调度层校验时也不会静默清空文件**;显式 `content: ""` 仍合法 = truncate 意图)

### 7. 修改 [edit.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/tools/edit.ts#L34-L44)(直调防线,微调)

`old_string`/`new_string` 增 `typeof !== "string"` 检查(直调防线,同上);**显式 `new_string: ""` 保持合法**(删除语义);现有 `!p || !oldStr`、`oldStr === newStr`、先读后改、新鲜度校验全部不动

### 8. 修改 [test/smoke.js](file:///Users/daqiao/Documents/workspace/claude-like/test/smoke.js)(新增 Part 10,顶部 require `validateToolInput`/`formatValidationIssues`)

1. **validator 单测**(~8 断言): 合法通过 / 必填缺失(Write.content)/ 类型错误(Bash `timeout: "30000"` → "需要 number")/ input 为数组与 null → `(input)` 问题 / `replace_all: "true"` 严格拒(boolean)/ 未知字段进文案不进 issues / 未声明 type 的属性跳过类型检查(MCP anyOf 形状)/ number 收 NaN 拒
2. **语义修正单测**(~6 断言): Bash 空 command 报错 / Bash `timeout: -5` 与 `timeout: 700000` 报错含区间 / Grep `max_results: -1` 报错 / Task `max_turns: 0` 报错 / Write 空 path 与 Read 空 path 明确报错 / Write 直调缺 content 报错且**文件不被清空**
3. **dispatch 集成**(复用 Part 6 的 MockProvider + 完整 QueryDeps 模式,~4 断言): mock 脚本发 `Write` 缺 content → tool_result isError 且文案含"必填" / **权限 responder 未被调用**(校验先于瀑布)/ PostToolUse hook 计数不变 / recordToolError 调用次数断言(⏳ 口径 1:计入 = 1,不计入 = 0)

### 9. 修改 [test/web-smoke.js](file:///Users/daqiao/Documents/workspace/claude-like/test/web-smoke.js)(新增 1 个 e2e,置末尾)

- `WEB_MOCK_SCRIPT` **末尾 append** 2 个 turn:`{ toolUses: [{ name: "Bash", input: { timeout: 30000 } }] }`(缺 command)+ `{ text: "…" }` 收尾——append 不动既有轮次,既有断言按事件内容匹配,已核对无影响(项目记忆:扩展须重数既有断言轮次)
- 新 test(第 17 个):专用会话三连发驱动 → 断言 `tool_result.isError` 且文案含"必填"/"command";顺带断言 perm 事件**不存在**(校验在瀑布前)
- 遵守项目记忆:新 e2e 在 stats 断言(14 号,`toolErrors === 1`)**之后**,不破坏;若口径 1 选计入,不新增 stats 断言(该会话 toolErrors 会 +1,只影响后续,14 号时点不变)

### 10. 更新 [README.md](file:///Users/daqiao/Documents/workspace/claude-like/README.md)(项目惯例:对照源码增量校准)

工具执行章节补:双层校验设计(调度层形状/工具内语义)、校验失败文案形态、失败不进权限瀑布不跑 PostToolUse、遥测口径、测试计数(smoke 52+n / web-smoke 22+1)。

## 关键约束(勿违反)

- **校验失败必须以 isError tool_result 入树**,不抛异常(消息树一致性——tool_use 必须有配对 tool_result)
- **未知字段不拒绝**(只提示);**显式空串/空 content 合法**(删除/ truncate 是正当意图)——"缺失"与"空"必须区分
- validator 只做 JSON Schema 子集检查,**不引入任何依赖**(零依赖是项目硬约束)
- PostToolUse Hook 只在工具真正执行后跑;校验失败/权限拒绝/未知工具均不跑(现状语义保持)
- smoke.js Part 6 的 Bash 短 timeout 用例不受影响:timeout 下界只查 `> 0`
- ⏳ 四项口径确认后,若与推荐不一致,先回改本方案第 3-9 节对应点再实施

## 验证

1. `npm run check` + `npm run build`(tsc 零错)
2. `node test/smoke.js` → 52 + Part 10 新增全绿
3. `node test/web-smoke.js` → 22 + 1 全绿(append 轮次已核对不影响既有断言)
4. `npm run demo` 回归(demo 脚本输入全部合法,校验零触发,行为不变)
