# 第 14 项: WebSearch 联网搜索工具

> 状态: 已实施(D1-D4 全按推荐落地: 客户端工具 + DDG 默认后端注入式 SearchFn + 静态 allow + smoke Part 18 八例)
> 前置: commit ed8f34c 基线(smoke 118/118, web-smoke 33/33, demo 24 轮)
> 参照: Claude Code WebSearch — 联网搜索工具(只读网络操作, 默认免确认)

## 1. 现状审计

| 接入点 | 现状 | 结论 |
|---|---|---|
| ToolRegistry([tool.ts](../../src/tools/tool.ts)) | 插拔式 register, 8 内置工具 | 一行注册 |
| 权限瀑布([engine.ts](../../src/permissions/engine.ts)) | ① deny 规则 → ② checkPermissions 静态 → ③ Hook → allow → 分类器 → 用户 | 静态 allow 即免弹窗; deny 规则/PreToolUse Hook 在前仍可拦; plan 模式放行 allow |
| 网络先例 | AnthropicProvider 零依赖 fetch + AbortController | 同款 |
| 超时/中止先例([bash.ts](../../src/tools/bash.ts)) | timeout 越界报错不 clamp + ctx.signal → "[aborted by user]" | 同款语义 |
| 输出上限先例 | bash.ts 200K 硬上限 + 截断尾注 | 同款(16K) |
| 输入校验([validate.ts](../../src/tools/validate.ts)) | required + 严格 typeof 前置 | schema 声明即生效 |
| Web UI 工具卡([index.html](../../demo/web/index.html)) | 通用渲染, inputSummary 兜底含 query 键 | 零前端改动 |
| explore 子代理([subagent.ts](../../src/agent/subagent.ts)) | 注册表仅 Read/Glob/Grep | 不纳入(保持纯代码库调查) |
| CHAT_SYSTEM_PROMPT(cli.ts) | 枚举可用工具 | 列表加 WebSearch |

## 2. 设计提案

### A. 新模块 src/tools/websearch.ts

- `SearchFn` 接口注入(测试 fake / 换后端); 默认 `duckDuckGoSearch`: fetch `html.duckduckgo.com/html/?q=` + 正则解析
- `parseDuckHtml` 纯函数导出(单测无网络): `result__a` 标题/链接 + `result__snippet` 摘要; `uddg=` 重定向参数解码; 去标签 + HTML 实体解码
- schema: `{query: string 必填, max_results?: number(1-10, 默认 5)}`; 越界报错不 clamp(Bash timeout 先例)
- 15s 固定超时(参数面最小化) + ctx.signal 中止; abort → "[aborted by user]" isError(Bash 同款)
- 输出: 编号 title/url/snippet + 尾部统计; 16K chars 硬上限截断尾注
- checkPermissions: 静态 allow — 免弹窗对标 Claude Code WebSearch 默认免确认
- 命中 log 一行 `[WebSearch] "query" → N 条`(web 事件流可见)

### B. 接线(2 处)

- cli.ts createSession: `tools.register(new WebSearchTool({ log: logS }))`(TodoWrite 后)
- CHAT_SYSTEM_PROMPT 可用工具列表加 `WebSearch(联网搜索)`

### C. 明确不动

- demo 脚本零改动(24 轮基线; Mock 不触发真实网络); Web UI / settings 零改动; explore 子代理不纳入

## 3. 测试计划(smoke Part 18, 8 例: 118 → 126)

① checkPermissions 静态 allow + inputSchema required/类型声明
② execute: 空 query → isError(调度层拦"缺失", 工具拦"显式空串" — 两层分工)
③ max_results 越界(0/11/2.5/"5")报错不 clamp; 合法值传至 searchFn
④ fake searchFn 正常渲染: 编号列表 + 统计行 + max_results 生效
⑤ 空结果 → "未找到" 非 isError; searchFn 抛错 → isError 含 query
⑥ 中止两态: 预先 aborted → 立即 "[aborted by user]"; 执行中 abort → 同款(fake 监听 signal)
⑦ parseDuckHtml 纯函数: 样例 HTML 提取 title/解码 uddg url/snippet + 去标签
⑧ 16K 截断尾注(fake 返回超长多结果)

## 4. 决策(全按推荐, 已批)

| 决策 | 结论 |
|---|---|
| D1 执行位置 | 客户端本地工具(注册表/权限/主循环/中止全链复用, fake 可测) — 非 Anthropic server tool 直通(改请求体 + 服务端计费, 破坏 Mock 语义) |
| D2 默认后端 | DuckDuckGo html 端点(零 key 即用) + SearchFn 注入式可替换; 解析 best-effort, 失败报 HTTP/解析错误 |
| D3 权限 | 静态 allow 免弹窗; deny 规则/PreToolUse Hook 在瀑布前层仍可拦; plan 模式放行 |
| D4 测试 | 仅 smoke 单测层(fake SearchFn + 纯函数解析), demo/web 零改动(第 13 项 D4 同口径) |

## 5. 范围外(不做)

- WebFetch 工具(域名级权限规则 WebFetch(domain:…)) — 后续项
- Tavily/Brave 等需 key 后端、搜索结果缓存、子代理联网
