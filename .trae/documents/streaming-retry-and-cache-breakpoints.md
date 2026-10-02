# 第 11 项: 流式重试 + cache 多断点

> 状态: 已完成(4 决策全按推荐落地); 回归: check/build ✓, smoke 106/106(+11), web-smoke 32/32, demo 24 轮
> 前置: smoke 95/95, web-smoke 32/32, demo 24 轮(commit 4d8aa56 后基线)

## 1. 现状审计

| 位置 | 现状 | 差距 |
|---|---|---|
| [anthropicProvider.ts](../../src/llm/anthropicProvider.ts) `complete`(L86-143) | 完整重试矩阵: 连接阶段网络错误 + 408/409/429/500/502/503/504/529 → 指数退避+jitter; 413/prompt_too_long → `ContextWindowExceededError`; 用户中断 → `RunAbortedError` | 无(基准) |
| `completeStream`(L146-227) | **零重试** — L168 注释"流式路径不重试 — 避免已渲染 delta 重复"。连接阶段 fetch 失败直接抛; 非 200 直接抛(仅 413 映射); SSE 中途断流: 用户中断→`RunAbortedError`(保留已渲染 delta), 其他直接抛 | 连接阶段/非 200 阶段**尚未渲染任何 delta**, 重试绝对安全; SSE 中途断流若零 delta 渲染亦可安全重试 — 现在一律不重试 |
| `buildBody`(L60-83) | 单断点: system 末块 `cache_control: ephemeral`(L71); tools 透传**无断点**; messages **无断点** | Anthropic 支持最多 4 断点; 标准打法缺 tools 末尾断点(第 2 断点)与消息历史稳定边界断点(第 3 断点) |
| [cacheBoundary.ts](../../src/context/cacheBoundary.ts) `buildRequest`(L45-57) | `prefixKey = sha256(model+max_tokens+system+tools)`; `DYNAMIC BOUNDARY` 划分前后缀 | 单一 prefixKey 只表达 system+tools 段; 消息历史前缀段(压缩摘要后的稳定部分)无指纹、无缓存命中模拟 |
| [query.ts](../../src/query.ts) 分支② | 每轮 `[cache] HIT/MISS prefix=...` 基于单段 prefixKey; T2/T3/T4/T5 压缩层改动 `state.messages` 后无边界记录 | 压缩后每轮 prefill 仍要重算整个 messages 段 KV; 摘要消息本是理想断点位置 |
| smoke Part 3(L181-312) | 假服务端队列 `{status, body|sse}` + hits 请求记录; 已测: 非流式重试矩阵/413 映射/SSE 聚合/SSE 413 | 流式重试矩阵、多断点请求体形状未测 |
| `applyMicroCompact`(microCompact.ts L15-34) | `messages.map` 替换旧 tool_result 内容, **消息数量不变** | — (边界索引在 state.messages 与 apiView 间一致, 无需换算) |

## 2. 设计提案

### A. 流式重试 — `completeStream` 对齐 `complete` 重试矩阵

安全原则: **只在"零 delta 已渲染"时重试**。`emitted` = onTextDelta 已回调次数; 一旦 >0, UI 已有渐进输出, 重试必然重复渲染 → 抛错结束本轮(上层 query.ts 已把已渲染文本留在 UI, 错误照常走分支⑤)。

三阶段分类(attempt 循环, 复用 `backoff` 退避; 重试时 blocks/jsonBuf/buf/emitted 全量重置):

| 阶段 | emitted | 行为 |
|---|---|---|
| ① 连接阶段(fetch 抛错) | 恒 0 | 网络错误 → 重试(与 complete 一致); 用户中断 → RunAbortedError |
| ② 响应阶段(非 200) | 恒 0(body 未消费) | RETRIABLE_STATUS(408/409/429/5xx/529) → 重试; 413/prompt_too_long → ContextWindowExceededError; 400 等 → 直接抛 |
| ③ 流读取阶段(SSE 中途抛错) | == 0 | **重试**(从头重新聚合, blocks 等状态已重置) |
| ③ 同上 | > 0 | 直接抛(已渲染 delta 保留在 UI); 用户中断 → RunAbortedError(优先) |

请求体逐字节相同(jitter 只进日志不进请求体) → 重试轮前缀照常命中 cache。

### B. cache 多断点 — tools 断点 + 消息摘要边界断点

buildBody(anthropic 真实请求体)三断点(Anthropic 上限 4, 此处 3 已覆盖收益):

```
断点 1(现有): system 末块 ephemeral
断点 2(新增): tools 数组最后一个 tool 加 cache_control
断点 3(新增): opts.cacheBreakpoint 指定索引处消息的末 content block 加 cache_control(深拷贝, 不污染消息树)
```

数据流(query.ts):

- `LoopState` 新增 `cacheBoundaryIndex: number | null`(initLoopState 置 null)
- **统一重置规则**: T2 snip / T3 collapse / T4 autocompact / T5 reactive 任一层成功改动 `state.messages` 后, `state.cacheBoundaryIndex = state.messages.length` — 该时点的树前缀在后续轮次只追加不变化, 是稳定缓存前缀。正常轮次(无压缩)消息树只 append, 边界保持
- 分支②调用 `complete`/`completeStream` 时透传 `cacheBreakpoint: state.cacheBoundaryIndex`(可为 null)
- T1 microCompact 消息数量不变 → 边界索引直接适用于 apiView, 无换算

cacheBoundary(mock 链路模拟, demo/测试的 [cache] 日志):

- `CacheSafeParams` + `cacheBreakpoint?: number`; `BuiltRequest` + `messagePrefixKey?: string`
- 有边界: `messagePrefixKey = sha256(stableStringify(messages.slice(0, breakpoint)))`
- query.ts `[cache]` 日志改为两段: `[cache] HIT p1=xxx` + 边界存在时 `[cache] HIT p2=yyy`(分段判定; messagePrefixKey 相同 → 消息前缀段命中)
- MockProvider 忽略 cacheBreakpoint(与 tools 一样仅真实 provider 消费)

### C. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/llm/provider.ts` | `CompleteOptions` + `cacheBreakpoint?: number`(StreamOptions 继承自动获得) |
| `src/llm/anthropicProvider.ts` | completeStream 三阶段重试矩阵; buildBody tools 断点 + 消息边界断点 |
| `src/context/cacheBoundary.ts` | buildRequest 支持 cacheBreakpoint → messagePrefixKey |
| `src/query.ts` | LoopState.cacheBoundaryIndex; 4 处压缩层成功后统一重置; 分支②透传; [cache] 日志两段化 |
| `test/smoke.js` | Part 3 扩展(流式重试矩阵 5 例) + Part 15(多断点 ~5 例) |
| `README.md` | 特性 bullet 更新 + 计数 |

### D. 测试计划

Part 3 扩展(假服务端, 新响应类型 `{status, sse, cutMid?: true}` — 发第一块后 `res.destroy()` 模拟半途断流):

1. 流式 500 → 重试 → SSE 成功(hits==2, deltas 无重复)
2. 流式 429 → 重试 → SSE 成功
3. 流式 cutMid 且零 delta(仅 message_start 后断) → 重试 → 成功(hits==2, deltas 只含成功轮)
4. 流式 cutMid 且已渲染 1 个 delta(content_block_delta 后断) → **不重试**直接抛(hits==1)
5. 流式 400 → 不重试(hits==1)
6. 请求体形状: tools 末尾 cache_control + cacheBreakpoint=0 时 messages[0] 末块 cache_control + 无边界时 messages 无断点

Part 15(cache 多断点):

1. buildRequest 无边界 → messagePrefixKey undefined
2. 有边界 → 两段指纹独立: 边界后消息变化不影响 messagePrefixKey, 边界内变化影响
3. runQuery 透传: stub provider(spy 记录 opts.cacheBreakpoint) + 预置 state → 断言调用序列收到预期边界值
4. T5 触发后边界重置: stub 第一次 complete 抛 ContextWindowExceededError、第二次正常 → reactiveCompact 后断言 boundary=压缩后树长(通过 spy 或日志)
5. T4 触发后边界重置(类似 4, 走 autocompact 分支)

回归: check/build + smoke 95→~105 + web-smoke 32(无新例, 流式路径 mock 不覆盖 anthropic; 但 [cache] 日志两段化需确认 demo 不受影响) + demo 24 轮。

### E. 已批准决策(AskUserQuestion 2026-10-02)

| 决策 | 选择 |
|---|---|
| 流式重试范围 | 三阶段全重试(连接 + 非 200 + 零 delta 中途), 已渲染 delta 不重试(推荐) |
| 已渲染 delta 的中途断流 | 直接抛错结束本轮, 已渲染文本保留在 UI(推荐) |
| tools 末尾断点 | 加(Anthropic 标准打法, 第 2 断点)(推荐) |
| 消息边界断点策略 | T2/T3/T4/T5 成功改树后统一重置到树尾(推荐) |
