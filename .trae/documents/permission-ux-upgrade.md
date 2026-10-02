# 第 8 项:权限弹窗 UX 升级(diff 预览 + 会话级"总是允许" + 前缀记忆)

## Context

权限系统已实现 8 层瀑布,但人工确认层(最后一米)仍是原始体验:弹窗只显示 JSON blob + 一次 yes/no。本方案补齐三块:
1. **Edit/Write diff 渲染预览** — 用户能看懂"要改什么"再决定
2. **本会话总是允许** — 一次选择,会话内同类操作免重复弹窗
3. **按命令前缀记忆**(Bash)— 如允许 `git push origin main` 后记住 `Bash(git push:*)`

已确认的设计决策:
- **前缀粒度**:首 token + 非 flag 第二 token(`git push origin main` → `Bash(git push:*)`,`ls -la` → `Bash(ls:*)`);含 `&;|<>` 等操作符的复合命令只记住完整命令本身(精确匹配),防止 `npm test && 危险命令` 被前缀放行
- **瀑布位置**:会话记忆插在 **ask 规则之前**(deny 规则/静态检查/Hook 之后)— 用户当场表态压过 settings 的 ask 规则,安全层全在前。静态 ask(git push --force)与 Hook ask 路径**不提供**"总是允许"(记忆在其后,提供不生效)
- 应答协议:`"yes" | "no"` → `"yes" | "no" | "always"`,单个 `always` 由引擎推导记忆规则

## 改动文件

### 1. 新增 `src/permissions/preview.ts`(核心新模块)

```ts
export interface PreviewLine { op: "ctx" | "del" | "add"; text: string }
export interface PermissionPreview {
  type: "edit" | "write-new" | "write-overwrite";
  path: string;
  lines: PreviewLine[];
  note?: string;
}
// 权限时刻构建人类可读预览(Edit/Write;其他工具返回 undefined → 前端回落 JSON)
export function buildPermissionPreview(toolName, toolInput, cwd): PermissionPreview | undefined
// 推导"总是允许"将记住的规则字符串(同 settings 规则语法)
export function deriveAlwaysRule(toolName, toolInput): string | undefined
```

**buildPermissionPreview 逻辑**:
- Edit:`fs.readFileSync` 读当前内容(**绝不调 fileState.markRead** — 防止污染 Edit 的先读后改校验;只读不改 mtime,不影响 freshness)。定位 old_string 首次出现,取前后各 2-3 行 ctx + `-` 旧行 + `+` 新行,总计截断 ~30 行(加 note)。额外 note 信号:`old_string 未找到(将失败)`、`出现 N 次(需唯一, 将失败)`(复用 `content.split(oldStr).length - 1` 计数逻辑,同 [edit.ts:68](file:///Users/daqiao/Documents/workspace/claude-like/src/tools/edit.ts#L68))、`文件不存在或不可读`
- Write:文件不存在 → `write-new`(前 ~20 行);存在 → `write-overwrite`(公共前后缀行裁剪后的 del/add diff + 旧行数/新行数 note)
- 路径 resolve 相对 `session.cwd`(= process.cwd(),与 EditTool 的 `path.resolve` 一致)
- Bash 及其他工具:`undefined`(Bash 的 JSON 只有 command 一个字段,本就易读)

**deriveAlwaysRule 逻辑**:
- 非 Bash 工具 → 工具名本身(`Edit` / `Write` / `mcp__echo__echo`,parseRule 支持无括号格式 → 匹配任意参数)
- Bash:命令含操作符(`[;&|<>]` 或 `` ` `` 或 `$(`)→ `Bash(完整命令)`(精确匹配,走 commandMatchesPrefix 的 `command === prefix` 分支);引号内操作符误判只会导致回落到精确匹配,安全方向。无操作符 → `normalizeForAllow(cmd)`(与后续 matchRule 检查路径用同一规范化,保证记住的规则能命中)→ 取 tokens[0],若 tokens[1] 存在且不以 `-` 开头则拼上 → `Bash(前缀:*)`
- 空命令 → undefined(不记忆)

### 2. 修改 `src/permissions/engine.ts`

- 导出 `export type PermissionAnswer = "yes" | "no" | "always"`;`EngineDeps.userResponder` 返回类型改为 `Promise<PermissionAnswer>`
- `PermissionAsk` 增加字段:`preview?: PermissionPreview`、`alwaysRule?: string`(本次选 always 将记住的规则;**undefined = 不提供 always 选项**,UI 据此隐藏按钮)
- 新增 `private sessionAllows: string[] = []`(规则语法同 settings,仅会话内存活,不落盘;**updateRules 热加载不动它** — settings 重载不清用户会话记忆)
- **瀑布插入 ⑤'**(在 ⑤ ask 规则之前):
  ```ts
  if (this.sessionAllows.length > 0) {
    const hit = matchRule(this.sessionAllows, "allow", name, toolInput);
    if (hit) return { decision: "allow", source: "session-allow", reason: `会话内已总是允许 ${hit}` };
  }
  ```
  import 增加 `matchRule`([rules.ts:98](file:///Users/daqiao/Documents/workspace/claude-like/src/permissions/rules.ts#L98) 已导出,复用现有匹配语义 — 含非对称规范化)
- `askUser(...)` 增加 `offerAlways: boolean` 参数:
  - 调 responder 前构建 `preview = buildPermissionPreview(...)`、`alwaysRule = offerAlways ? deriveAlwaysRule(...) : undefined`,随 PermissionAsk 传给 responder
  - answer 类型扩展 `"always"`;race/abort 逻辑不变
  - `"always"`:sessionAllows 去重后 push 规则,log `[perm] 会话内总是允许: ${rule}(后续免确认)`,返回 `{ decision: "allow", source: "user", reason: "用户弹窗放行 + 会话记忆 ${rule}" }`
- 四个 askUser 调用点的 offerAlways:② 静态 ask([engine.ts:83](file:///Users/daqiao/Documents/workspace/claude-like/src/permissions/engine.ts#L83))→ **false**;③ Hook ask(L99)→ **false**;⑤ ask 规则(L120)→ true;⑧ 兜底用户(L141)→ true

### 3. 修改 `src/events.ts`

- `permission_request` 事件增加 `preview?: PermissionPreview`、`alwaysRule?: string`(type import 自 `./permissions/preview`,该模块只依赖 fs/path/types,无循环)
- `permission_resolved` 的 answer 扩为 `"yes" | "no" | "always"`

### 4. 修改 `src/web/server.ts`

- `PendingPerm.resolve` 类型改 `(answer: PermissionAnswer) => void`(import type from engine)
- `makeUserResponder`([server.ts:92-98](file:///Users/daqiao/Documents/workspace/claude-like/src/web/server.ts#L92-L98)):Promise 泛型改 `PermissionAnswer`;req 事件构造时展开新字段(仅存在时:`...(ask.preview ? { preview: ask.preview } : {})`,alwaysRule 同)→ SSE 重放(/api/events 补放、/api/session/history pendingPerms)存的是完整 req 对象,新字段自动跟随,无需额外改
- `flushSessionPerms` 不变(resolve "no" 仍合法)
- POST handler([server.ts:397](file:///Users/daqiao/Documents/workspace/claude-like/src/web/server.ts#L397)):`answer = body.answer === "yes" ? "yes" : body.answer === "always" ? "always" : "no"`

### 5. 修改 `src/cli.ts`(chat 模式弹窗,[cli.ts:440-456](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L440-L456))

- 有 `req.preview` 时,question 前打印预览行:`  - 旧行` / `  + 新行` / `  ␣ 上下文`(纯文本,不动 ANSI 颜色)+ note
- 提示语:有 alwaysRule → `允许? [y=允许 a=总是允许本会话(${req.alwaysRule}) / N=拒绝] `;否则维持 `(y/N)`
- 应答解析:`a` 前缀且 req.alwaysRule 存在 → "always";`y` 前缀 → "yes";其余 → "no"。abort 收尾(rl.write("\n"))逻辑不变
- demo 的脚本化 responder(L350-353 返回 "no")类型兼容,不改

### 6. 修改 `demo/web/index.html`

- **HTML**(overlay,[index.html:170-179](file:///Users/daqiao/Documents/workspace/claude-like/demo/web/index.html#L170-L179)):`#perm-input` 前插入 `<div id="perm-diff"></div>`;`#perm-actions` 中 no 与 yes 之间加 `<button id="perm-always"></button>`
- **CSS**:`#perm-diff` 复用 `#perm-input` 的块样式;行色 `.dl`(del→var(--err))、`.da`(add→var(--ok))、`.dc`(ctx→var(--dim));`#perm-always` outline 风格按钮(默认 display:none)
- **JS** `nextPerm()`([index.html:311-318](file:///Users/daqiao/Documents/workspace/claude-like/demo/web/index.html#L311-L318)):
  - 有 preview → 渲染标题行(path)+ diff 行到 `#perm-diff`,隐藏 `#perm-input`;无 → 反之(现状)
  - 有 alwaysRule → 显示 always 按钮并置文案 `总是允许 ${alwaysRule}(本会话)`;无 → 隐藏
- `$("perm-always").onclick = () => answerPerm("always")`;Esc 仍映射 no;answerPerm 已泛型无需改
- `permission_resolved` 消费端只关弹窗,不区分 answer 值,无需改

### 7. 修改 `test/smoke.js`(新增 1 个测试块,~8 断言)

复用现有 `new PermissionEngine({...userResponder})` 模式(L348/L420):
1. **always 前缀记忆**:Bash `git push origin main` → responder 返回 "always" → allow(source "user");同前缀 `git push origin other` → allow(source "session-allow"),**responder 调用计数不变**;`git push --force` → 静态 ask 拦截且收到的 `req.alwaysRule === undefined`
2. **deny 不可覆盖**:sessionAllows 含 `Bash(git push:*)` 后 `git push && rm -rf /tmp/x` → rule-deny 拒绝
3. **Edit 工具级记忆**:Edit 选 always → 第二次 Edit 免弹窗(session-allow)
4. **ask 规则压制**:rules.ask 含 `Bash(npm test:*)`,`npm test` 选 always → 第二次不再弹(session-allow 命中于 ⑤')
5. **复合命令精确记忆**:`npm test && git status` 选 always → sessionAllows 记完整命令(无 :*);逐字重复命令命中,`npm test && git push` 不命中
6. **preview 单测**:临时文件 → Edit diff(ctx/del/add 行)、old_string 未找到 note、多次出现 note;Write 新文件/覆盖(公共前后缀裁剪)
7. **fileState 无污染**:buildPermissionPreview 读文件后,EditTool.execute 仍报 "has not been read"(freshness 仍 unread)
- 既有 `async () => "yes"` / `async () => "no"` responder 类型兼容,零改动

### 8. 修改 `test/web-smoke.js`(新增 1 个 e2e,置末尾)

- **`WEB_MOCK_SCRIPT` 末尾 append 2 个 turn**:`{ toolUses: [{ name: "Bash", input: { command: "date" } }] }` + `{ text: "…" }` — append 不动既有轮次消耗(既有断言按事件内容匹配,安全;遵守项目记忆:扩展脚本需重数既有断言轮次,append 方式已核对无影响)
- 新 test(第 14 个):`POST /api/session/new` 专用会话 → 三连发消息驱动脚本:
  - msg1:turn1 ls + turn2 date 弹窗 → 断言 `permission_request.alwaysRule === "Bash(date:*)"`(单 token 无操作符)→ POST answer **"always"** → `permission_resolved.answer === "always"` → perm source "user" → tool_result ok
  - msg2:消费原 turn4/turn5(fail-ls + stop),无新断言
  - msg3:append 的 date turn → 断言 tool_result ok 且 perm `source === "session-allow"`,并在快照后的事件数组中断言**无第二次 permission_request**(过滤断言而非 waitFor)
- 既有 test 5/10 的 date 弹窗答 "yes"/"no" 不受影响

### 9. 更新 `README.md`(项目惯例:对照源码增量校准)

权限章节补:弹窗三选项语义、会话级记忆(⑤' 层,更新瀑布顺序图)、diff 预览、alwaysRule 不生效的路径(静态 ask/Hook ask)、会话记忆不跨会话不落盘。

## 关键约束(勿违反)

- preview 读取文件**禁止触碰 fileState**(不 markRead、不 markWritten)— Edit 的先读后改校验是项目硬约束
- 会话记忆**必须**复用 `matchRule`(非对称规范化语义),不得另写匹配
- deriveAlwaysRule 对 Bash 用 `normalizeForAllow`,与 matchRule allow 路径一致,否则记住的规则匹配不上
- sessionAllows 仅内存态:不写 transcript、不进 settings、新会话不继承
- settings 热加载(updateRules)只换 deps.rules,不清洗 sessionAllows

## 验证

1. `npm run build`(tsc 编译零错)
2. `node test/smoke.js` → 43 + 新增断言全绿
3. `node test/web-smoke.js` → 13 + 1 全绿
4. `npm run demo` 回归(demo responder 类型兼容,权限链路行为不变)
5. 手工 `npm run web` 浏览器(带 token):发消息触发弹窗 → Edit/Write 见 diff 渲染、Bash 见"总是允许"按钮;选 always 后同前缀免弹窗,工具卡片 perm 标注来源 session-allow;Esc/拒绝路径回归
