# 第 6 项: 非交互 Headless 模式(chat -p / stdin 管道 / 结构化输出)

## Context — 现状审计

| # | 现状 | 位置 | 问题 |
|---|------|------|------|
| 1 | main() 分发仅 demo\|chat\|key\|web | [cli.ts:622-634](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L622-L634) | 无单发非交互入口,脚本/CI/管道无法调用 |
| 2 | chat 强绑定 readline | [cli.ts:454](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L454) `createInterface` + [L546](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L546) `rl.on("line")` + [L581](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L581) `await new Promise(()=>{})` 自持事件循环 | stdin 为管道时仍等交互输入 → 挂死;`cat log \| chat` 不可用 |
| 3 | 权限兜底层 = readline question | [cli.ts:470-502](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L470-L502) userResponder | headless 无终端可弹窗 → 未命中规则的工具调用会永久挂起 |
| 4 | 无 --output-format | stdout 混杂 log/渲染文本 | 脚本无法稳定提取最终回复;无 JSON 元数据(轮次/tokens/错误) |
| 5 | UiEvent 事件通道已存在 | [events.ts:6-45](file:///Users/daqiao/Documents/workspace/claude-like/src/events.ts#L6-L45) 16 种事件 + `createSession({emit})` 桥接 | stream-json 输出可零成本复用(每事件一行 JSONL) |
| 6 | createSession 为可复用组装点 | [cli.ts:98-301](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L98-L301) `send()` 单条驱动到 Stop;`state.turnCount/totalTokensUsed` 已有 | headless = 组装 + 一次 send + 提取最终文本 + 统计收尾,无需动引擎 |
| 7 | mock 通道不对称 | web 无 key 回退 mock([server.ts:199-200](file:///Users/daqiao/Documents/workspace/claude-like/src/web/server.ts#L199-L200));chat 无 key 直接抛错([cli.ts:392-399](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L392-L399)) | headless 需要无 key 测试路径,但不能像 web 静默回退(生产脚本拿到 mock 响应 + exit 0 是事故)→ 需显式 env 注入 |

## 设计提案

### 1. 入口: `chat -p "query"`(别名 --print),复用 chat 全部 flags

```
node dist/cli.js chat -p "查一下目录" [--output-format text|json|stream-json]
                      [--permission-mode default|auto|plan|bypassPermissions]
                      [--resume [sessionId]] [--plan] [--append-system-prompt "…"]
cat app.log | node dist/cli.js chat -p "总结这个日志"        # stdin 作为附加上下文
cat prompt.txt | node dist/cli.js chat --output-format json   # 无 -p: stdin 即提示词
```

- 分流位置: `runChat()` 开头 — 解析 `-p`/stdin 后进 `runHeadless()`,两者皆无才创建 readline(交互行为零变化)。
- `--permission-mode`: headless 无法 `/mode` 运行中切换 → 启动 flag 指定;默认 `auto`(对齐交互 chat);`bypassPermissions` 沿用既有约定须追加 `--dangerous`。`--plan` 保留为 `--permission-mode plan` 的简写(兼容习惯)。
- 会话互通: sessionId 沿用 `sess_chat_*` 前缀 → headless 会话可被交互 `chat --resume` 列出续接,反之亦然;transcript 照常落盘。

### 2. stdin 管道语义(双语义)

| 场景 | 行为 |
|------|------|
| `-p "Q"` + stdin 管道 | prompt = `Q\n\n--- stdin 附加内容 ---\n<stdin 全文>`(对标 `cat log \| claude -p "summarize"`) |
| 无 `-p` + stdin 非 TTY | stdin 全文即提示词(单发 headless) |
| 无 `-p` + stdin 是 TTY | 交互 REPL(现状不变) |

判定: `process.stdin.isTTY`;全量读入用一次性 read(stream 读到 end)。

### 3. 输出格式(--output-format,默认 text)

| 格式 | stdout | stderr |
|------|--------|--------|
| `text` | 仅最终助手文本(消息树最后一条 assistant 的 text 块拼接)+ `\n` | 全部进度 log(logFn 重定向 stderr → stdout 纯净可管道) |
| `json` | 单个 JSON 对象: `{result, sessionId, mode, turns, totalTokensUsed, toolUses, permissionDenials, errors, interrupted}` | 同上 |
| `stream-json` | JSONL 逐行: 复用 UiEvent(`emit` 桥接, 含 user_message/tool_start/perm/tool_result/assistant_delta/…) + 终行 `{kind:"result", …统计}` | 同上 |

- `renderDelta`: text/json 不传(stdout 不流式渲染);stream-json 传 emit 桥接(assistant_delta 事件照发)。
- 中断(interrupted): headless 的 SIGINT = `session.abort()` 优雅收尾 → 正常输出已生成部分 + `interrupted:true`,不视为故障;运行中第二次 SIGINT 强制退出(130)。

### 4. 权限无人值守语义

瀑布前几层**照常生效**(deny 规则 → 静态检查 → PreToolUse Hook → allow 规则 → 会话记忆;auto 模式两阶段分类器照常):

- 落到 userResponder(需人工确认)→ **自动拒绝**: stderr 记一行 `[headless] 权限弹窗自动拒绝: <tool>(<input 摘要>)`,`permissionDenials++`。
- 引擎收到 `no` → 生成 error tool_result("permission denied")→ 模型看到拒绝反馈后继续换路(与 Web 弹窗拒绝对齐,不终止运行)。
- 实现层: `userResponder` 传 headless 版(req.signal.aborted 时同样返 no,参考 [cli.ts:477-481](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts#L477-L481) 既有中断处理),不改 PermissionEngine。

### 5. exit code

| code | 含义 |
|------|------|
| 0 | 运行完成 — 权限拒绝/工具错误/413→T5 恢复均属**业务结果**,不是系统故障 |
| 1 | 系统故障 — key 缺失/参数非法/mock env 解析失败/provider 致命错/预算熔断/无最终文本 |
| 130 | 运行中第二次 SIGINT 强制退出 |

### 6. mock 测试通道: `AGENT_HARNESS_MOCK_SCRIPT`(显式 opt-in)

```
AGENT_HARNESS_MOCK_SCRIPT='[{"toolUses":[{"name":"Bash","input":{"command":"date"}}]},{"text":"done"}]' \
  node dist/cli.js chat -p "test" --output-format json
```

- env 存在 → JSON.parse 为 `ScriptedTurn[]` → MockProvider(优先于 key;仅 headless 消费,交互 chat 不受影响)。
- env 不存在 → 与 chat 相同的 key 解析(env > Keychain;无则报错 exit 1)。
- 对比 web 的静默回退: 显式注入避免"生产脚本无 key 拿到 mock 响应还 exit 0"的事故。

## 涉及文件

| 文件 | 改动 |
|------|------|
| [src/cli.ts](file:///Users/daqiao/Documents/workspace/claude-like/src/cli.ts) | runChat 开头分流(-p/stdin 判定);新增 `runHeadless(args, opts)`(~110 行: provider 选择/mock env、组装 createSession、无人值守权限、按格式输出、exit code);main() 不动 |
| [test/smoke.js](file:///Users/daqiao/Documents/workspace/claude-like/test/smoke.js) | Part 13 新增 ~8 例(子进程 spawn + AGENT_HARNESS_MOCK_SCRIPT) |
| [README.md](file:///Users/daqiao/Documents/workspace/claude-like/README.md) | 特性列表 + headless 用法章节 + 测试计数更新 |
| src/query.ts / events.ts / permissions/* | **零改动**(复用 emit/send/stats 现有接口) |

不拆独立模块: headless 与 cli.ts 内聚度高(CHAT_SYSTEM_PROMPT/loadSettings/resolveApiKey/SESSIONS_DIR),拆分需 lazy require 解循环依赖(web/server.ts 模式),收益不抵复杂度;cli.ts 增量 ~110 行可接受。

## 测试计划(smoke Part 13,子进程 spawn;web-smoke 无改动维持 29)

1. **-p 基本链路**: mock [ls(白名单放行), text] → stdout 含最终文本;stdout 无 log 噪音(log 走 stderr);exit 0
2. **权限自动拒绝**: mock [date(未命中规则), text] → 自动拒绝 → tool_result error → 模型继续 → 最终文本;exit 0;stderr 含"自动拒绝"
3. **--output-format json**: JSON 可解析;字段齐全(result/sessionId/mode/turns/totalTokensUsed/toolUses/permissionDenials/exit 0)
4. **--output-format stream-json**: JSONL 逐行可解析;kind 集合含 user_message/tool_start/perm/tool_result/assistant_message/stop + 终行 result
5. **stdin 附加语义**: `echo 附加内容 \| chat -p "问题"` → transcript 中 user 消息同时含 query 与 stdin 内容
6. **纯 stdin 提示词**: `echo "直接提问" \| chat`(mock) → transcript user 消息 == stdin 全文
7. **--permission-mode plan**: mock 请求 Write → plan 门禁拒绝 → exit 0;transcript 有 error tool_result
8. **系统故障 exit 1**: 无 key 无 mock env → exit 1 + stderr 提示;`--output-format yaml`(非法值)→ exit 1

## 待确认决策

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| ① | 入口形态 | `chat -p`(别名 --print,对齐 Claude Code `claude -p`;复用 chat flags 与 main() 分发) | 独立 `run` 子命令 |
| ② | stdin 语义 | 双语义: 有 -p = 附加上下文;无 -p + 管道 = stdin 即提示词 | 仅支持 -p,不读 stdin |
| ③ | --output-format 范围 | text\|json\|stream-json 三档全做(stream-json 复用 UiEvent 近零成本) | 仅 text\|json |
| ④ | 无人值守权限 | 规则/静态/Hook/allow/分类器照常;落到弹窗层自动拒绝(模型收到拒绝反馈可换路);--permission-mode 默认 auto | A. 未显式 allow 一律拒(更严) B. 弹窗即终止运行 |
| ⑤ | exit code | 0=运行完成(拒绝/工具错误属业务结果);1=系统故障 | 权限拒绝/工具错误也非零(对脚本更严格) |
