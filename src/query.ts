// 架构参考: query.ts 主循环 — 命名 continue 分支状态机(原版 7 分支):
//   ① 压缩触发检查(T2/T3/T4 + 水位遥测)  ② LLM 调用(含 413 恢复路径)
//   ③ 工具调用分发(权限瀑布)  ④ Stop(无工具调用)  ⑤ 错误升级/熔断
import * as fs from "fs";
import { Message, RunAbortedError, ToolResultBlock, ToolUseBlock } from "./types";
import { estimateConversationTokens } from "./context/tokenEstimator";
import { buildRequest } from "./context/cacheBoundary";
import { LLMProvider, ContextWindowExceededError } from "./llm/provider";
import { CompactConfig, computeWatermarks } from "./compact/watermarks";
import { enforceToolResultBudget } from "./compact/toolResultBudget";
import { applyMicroCompact } from "./compact/microCompact";
import { snipCompact } from "./compact/snipCompact";
import { contextCollapse, CollapseState } from "./compact/contextCollapse";
import { autoCompact } from "./compact/autoCompact";
import { reactiveCompact } from "./compact/reactiveCompact";
import { PermissionEngine } from "./permissions/engine";
import { HookRunner } from "./hooks/runner";
import { ToolRegistry } from "./tools/tool";
import { validateToolInput, formatValidationIssues } from "./tools/validate";
import { DiagnosticsBuffer } from "./tools/diagnostics";
import { UiEvent } from "./events";
import { Telemetry } from "./telemetry/telemetry";

export type QuerySource = "user" | "compact";

export interface LoopState {
  messages: Message[];
  collapseState: CollapseState;
  consecutiveAutoCompactFailures: number;
  hasAttemptedReactiveCompact: boolean;
  archivedFiles: string[]; // T0/T2 落盘累计(T4 恢复预算候选)
  t1ClearedIds: Set<string>; // 已进入 T1 清除范围的结果(遥测去重: 视图每轮重建)
  warned: boolean;
  lastPrefixKey: string | null;
  // 消息历史稳定边界(第 3 cache 断点): T2/T3/T4/T5 任一压缩层成功改树后重置到树尾,
  // [0, boundary) 在后续轮次只追加不变化; 正常轮次消息树只 append, 边界保持
  cacheBoundaryIndex: number | null;
  lastMessagePrefixKey: string | null; // [cache] p2 分段命中判定的上一轮指纹
  turnCount: number;
  totalTokensUsed: number; // 会话累计计费 tokens(预算熔断依据; 跨 send 持续累计)
}

export interface QueryDeps {
  provider: LLMProvider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  hooks: HookRunner;
  cfg: CompactConfig;
  systemPrompt: string[];
  systemTokens: number;
  model: string;
  artifactsDir: string;
  session: { sessionId: string; transcriptPath: string; cwd: string };
  getUserMessages: () => string[]; // 分类器盲视输入(用户消息逐字)
  // 流式渲染回调(可选): provider 支持 completeStream 时文本增量渐进输出
  renderDelta?: (text: string) => void;
  // 结构化 UI 事件(可选): web 前端消费; CLI 不传, log 仍是唯一输出通道
  emit?: (e: UiEvent) => void;
  // 用户中断信号(可选): Ctrl-C / Web 停止按钮 → 中断 LLM 请求/工具执行/压缩侧查询;
  // 中断时保证消息树一致性(未完成的 tool_use 补 error 结果)后抛 RunAbortedError
  signal?: AbortSignal;
  // 引擎预算(可选, settings.json engine 段): 轮次上限与累计 token 熔断(失控保护)
  maxTurns?: number;
  tokenBudget?: number;
  // 错误遥测(可选): 工具级失败计数(引擎级异常由 cli.ts createSession 统一记录)
  telemetry?: Telemetry;
  // 诊断回灌(可选): lint/test/build 类 Bash 命令结果缓冲 → 下一条用户消息注入未解决项(cli.ts send 消费)
  diagnostics?: DiagnosticsBuffer;
  log: (line: string) => void;
}

export function initLoopState(): LoopState {
  return {
    messages: [],
    collapseState: { firedLevels: [] },
    consecutiveAutoCompactFailures: 0,
    hasAttemptedReactiveCompact: false,
    archivedFiles: [],
    t1ClearedIds: new Set(),
    warned: false,
    lastPrefixKey: null,
    cacheBoundaryIndex: null,
    lastMessagePrefixKey: null,
    turnCount: 0,
    totalTokensUsed: 0,
  };
}

function appendTranscript(deps: QueryDeps, m: Message): void {
  fs.appendFileSync(
    deps.session.transcriptPath,
    JSON.stringify({ ts: new Date().toISOString(), role: m.role, content: m.content }) + "\n",
    "utf8"
  );
}

// 请求视图 tokens = T1 视图 + 系统提示
function viewTokens(deps: QueryDeps, messages: Message[]): number {
  const view = applyMicroCompact(messages, deps.cfg);
  return estimateConversationTokens(view.messages) + deps.systemTokens;
}

export async function runQuery(
  deps: QueryDeps,
  state: LoopState,
  source: QuerySource,
  maxTurns?: number
): Promise<LoopState> {
  const wm = computeWatermarks(deps.cfg);
  const sess = deps.session;
  // 轮次上限: 显式参数(子代理) > settings engine.maxTurns > 默认 200
  const turns = maxTurns ?? deps.maxTurns ?? 200;

  for (let turn = 0; turn < turns; turn++) {
    // ── 用户中断检查(每轮入口; 中断在中途发生时由各阶段的 signal 检查/RunAbortedError 路径收尾) ──
    if (deps.signal?.aborted) throw new RunAbortedError();

    // ── 预算熔断: 会话累计 tokens 超限 → 拒绝下一轮请求(失控保护; 此时消息树必一致) ──
    if (deps.tokenBudget && state.totalTokensUsed >= deps.tokenBudget) {
      throw new Error(
        `token 预算熔断: 本会话累计 ${state.totalTokensUsed} tokens ≥ 预算 ${deps.tokenBudget} ` +
        `(settings.json engine.tokenBudget)。如需继续, 请调高预算后重启会话。`
      );
    }

    // ── 分支①: 压缩触发检查(每轮请求前) ──
    let tokens = viewTokens(deps, state.messages);

    // warning 水位(一次性提示, T4 成功后重置)
    if (!state.warned && tokens >= wm.warningAt) {
      state.warned = true;
      deps.log(`[warn] 上下文接近水位: ${tokens} ≥ warningAt ${wm.warningAt}`);
    }

    // T2 snip: 本地树原位归档(无 LLM)
    if (tokens > deps.cfg.snipTarget + deps.cfg.autoCompactThreshold) {
      const before = tokens;
      const t2 = snipCompact(state.messages, tokens, deps.cfg, deps.artifactsDir);
      if (t2.archived > 0) {
        state.messages = t2.messages;
        state.cacheBoundaryIndex = state.messages.length; // 压缩改树 → 边界重置到树尾(统一规则)
        state.archivedFiles.push(...t2.files);
        tokens = viewTokens(deps, state.messages);
        deps.emit?.({ kind: "compact", level: "T2", detail: `snip 归档 ${t2.archived} 条消息, ${before} → ${tokens} tokens` });
        deps.log(
          `[compact] T2 snip: archived ${t2.archived} msgs, ${before} → ${tokens} tokens ` +
            `(buffer ${before} > target+${deps.cfg.autoCompactThreshold})`
        );
      }
    }

    // T3 collapse: 90/92/94% 每水位折一段(渐进退化)
    const t3 = await contextCollapse(
      state.messages, deps.cfg, wm, deps.provider, state.collapseState, deps.log, deps.signal
    );
    if (t3.folded) {
      state.messages = t3.messages;
      state.cacheBoundaryIndex = state.messages.length; // 压缩改树 → 边界重置到树尾(统一规则)
      tokens = viewTokens(deps, state.messages);
    }

    // T4 autocompact: effectiveWindow − 13K 触发(fork 子 Agent, 继承 cache 前缀)
    if (tokens >= wm.autoCompactAt) {
      if (source === "compact") {
        // 递归守卫: 压缩子 Agent 的查询不再触发 autocompact
        deps.log("[compact] T4 递归守卫: querySource=compact, 跳过 autocompact");
      } else {
        deps.emit?.({ kind: "compact", level: "T4", detail: `autocompact 触发 (buffer ${tokens} ≥ ${wm.autoCompactAt})` });
        deps.log(`[compact] T4 autocompact: 触发 (buffer ${tokens} ≥ ${wm.autoCompactAt})`);
        try {
          const t4 = await autoCompact(
            deps.provider, state.messages, deps.cfg,
            [...new Set(state.archivedFiles)], deps.log, deps.signal
          );
          state.messages = t4.messages;
          state.cacheBoundaryIndex = state.messages.length; // 压缩改树 → 边界重置到树尾(统一规则)
          state.consecutiveAutoCompactFailures = 0;
          state.warned = false;
          tokens = viewTokens(deps, state.messages);
          deps.emit?.({ kind: "compact", level: "T4", detail: `autocompact 完成, buffer 压至 ${tokens} tokens` });
          deps.log(`[compact] T4 autocompact: 压缩后 buffer ${tokens} tokens; 主循环下轮请求将命中同一 cache 前缀`);
        } catch (e) {
          state.consecutiveAutoCompactFailures++;
          deps.log(
            `[compact] T4 autocompact 失败 (${state.consecutiveAutoCompactFailures}/` +
            `${deps.cfg.maxConsecutiveAutoCompactFailures}): ${(e as Error).message}`
          );
          if (state.consecutiveAutoCompactFailures >= deps.cfg.maxConsecutiveAutoCompactFailures) {
            // 熔断: 连续失败达上限, 升级为用户可见错误
            throw new Error(`autocompact 熔断: 连续失败 ${state.consecutiveAutoCompactFailures} 次`, { cause: e });
          }
          if (tokens >= wm.blockingAt) {
            throw new Error(`blocking 水位 ${wm.blockingAt} 且 autocompact 失败, 拒绝继续`, { cause: e });
          }
        }
      }
    }

    // blocking 水位: 拒绝新请求(正常情况 T4 已把 buffer 拉回)
    if (tokens >= wm.blockingAt) {
      throw new Error(`blocking 水位: buffer ${tokens} ≥ ${wm.blockingAt}, 拒绝新请求`);
    }

    // ── 构建请求: cache 边界(稳定前缀 + DYNAMIC BOUNDARY + 动态消息) ──
    // T1 microCompact 在 API 层完成(本地消息树不变); 遥测只报告本轮新进入清除范围的结果
    const t1 = applyMicroCompact(state.messages, deps.cfg);
    const newlyCleared = t1.clearedIds.filter((id) => !state.t1ClearedIds.has(id));
    if (newlyCleared.length > 0) {
      newlyCleared.forEach((id) => state.t1ClearedIds.add(id));
      deps.emit?.({ kind: "compact", level: "T1", detail: `micro 新清除 ${newlyCleared.length} 个旧工具结果(API 层)` });
      deps.log(`[compact] T1 micro: 新清除 ${newlyCleared.length} 个旧工具结果(API 层完成, 本地消息树不变)`);
    }
    const apiView = t1.messages;
    // T1 microCompact 消息数量不变 → cacheBoundaryIndex 直接适用于 apiView, 无需索引换算
    const req = buildRequest({
      model: deps.model,
      system: deps.systemPrompt,
      tools: deps.tools.toSchemas(),
      messages: apiView,
      max_tokens: deps.cfg.maxOutputTokens,
      cacheBreakpoint: state.cacheBoundaryIndex ?? undefined,
    });
    // [cache] 两段判定: p1 = system+tools 稳定前缀; p2 = 消息历史稳定段(压缩边界后才有)
    if (state.lastPrefixKey === req.prefixKey) {
      deps.log(`[cache] HIT  p1=${req.prefixKey} (稳定前缀复用)`);
    } else {
      deps.log(`[cache] MISS p1=${req.prefixKey}`);
      state.lastPrefixKey = req.prefixKey;
    }
    if (req.messagePrefixKey) {
      if (state.lastMessagePrefixKey === req.messagePrefixKey) {
        deps.log(`[cache] HIT  p2=${req.messagePrefixKey} (消息前缀段复用)`);
      } else {
        deps.log(`[cache] MISS p2=${req.messagePrefixKey}`);
        state.lastMessagePrefixKey = req.messagePrefixKey;
      }
    }

    deps.log(
      `[loop] turn ${++state.turnCount} | buffer ${tokens} tokens ` +
      `(${((tokens / wm.effectiveWindow) * 100).toFixed(1)}% of effectiveWindow ${wm.effectiveWindow})`
    );
    // 用量事件(轮入口快照): buffer 为本轮请求上下文规模, totals 为截至上一轮累计;
    // 水位阈值随附 → 前端水位条分区着色(T4 压缩后下一轮自然回落)
    deps.emit?.({
      kind: "usage",
      turn: state.turnCount,
      bufferTokens: tokens,
      totalTokensUsed: state.totalTokensUsed,
      tokenBudget: deps.tokenBudget,
      watermarks: {
        effectiveWindow: wm.effectiveWindow,
        autoCompactAt: wm.autoCompactAt,
        warningAt: wm.warningAt,
        blockingAt: wm.blockingAt,
      },
    });

    // ── 分支②: 调用 LLM(流式优先, 413 恢复路径) ──
    let response: Message;
    let streamed = false; // 流式渐进渲染后不再整行重打"助手回复"
    try {
      const callOpts = {
        maxTokens: deps.cfg.maxOutputTokens,
        tools: deps.tools.toSchemas(), // 真实 provider 需要工具定义(Mock 忽略)
        signal: deps.signal, // 用户中断: fetch 层中止(流式路径已渲染的 delta 保留)
        cacheBreakpoint: state.cacheBoundaryIndex ?? undefined, // 第 3 断点透传(真实 provider 消费)
      };
      const completion = deps.provider.completeStream
        ? ((streamed = true), await deps.provider.completeStream(deps.systemPrompt, apiView, { ...callOpts, onTextDelta: deps.renderDelta }))
        : await deps.provider.complete(deps.systemPrompt, apiView, callOpts);
      // 真实 API 用量与 prompt cache 命中遥测 + 预算累计(全部计费口径, 含 cache 读写)
      if (completion.usage) {
        const u = completion.usage;
        state.totalTokensUsed +=
          u.input_tokens + u.output_tokens +
          (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        deps.telemetry?.recordUsage(deps.session.sessionId, u); // 5h 滚动窗口聚合源(usage.jsonl)
        deps.log(
          `[usage] in=${u.input_tokens} out=${u.output_tokens} ` +
          `cache_read=${u.cache_read_input_tokens ?? 0} cache_create=${u.cache_creation_input_tokens ?? 0}` +
          ` | 会话累计 ${state.totalTokensUsed}${deps.tokenBudget ? `/${deps.tokenBudget}` : ""} tokens`
        );
      }
      response = completion.message;
    } catch (err) {
      if (err instanceof ContextWindowExceededError) {
        // ── T5 reactive compact: 413 等价错误 ──
        if (state.hasAttemptedReactiveCompact) {
          // 一次性守卫: 已尝试过仍失败 → 直接抛给用户
          deps.log("[compact] T5 reactive: 一次性守卫触发, 错误直接抛给用户");
          throw err;
        }
        state.hasAttemptedReactiveCompact = true;
        deps.emit?.({ kind: "compact", level: "T5", detail: "413 等价错误 → reactive compact(保留最后 4 条 + 全量摘要)" });
        deps.log("[compact] T5 reactive: 413 等价错误 → 只保留最后 4 条消息, 全量摘要");
        state.messages = await reactiveCompact(deps.provider, state.messages, deps.log, deps.signal);
        state.cacheBoundaryIndex = state.messages.length; // 压缩改树 → 边界重置到树尾(统一规则)
        continue;
      }
      throw err;
    }
    state.messages.push(response);
    appendTranscript(deps, response);
    // 非流式(mock/无 completeStream): 整段文本外发; 流式已由 renderDelta 渐进渲染
    if (!streamed) {
      const fullText = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (fullText) deps.emit?.({ kind: "assistant_message", text: fullText });
    }

    // ── 分支③: 工具调用分发 ──
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // ── 分支④: Stop(本轮结束) ──
      await deps.hooks.run("Stop", {}, sess);
      if (streamed) {
        deps.renderDelta?.("\n"); // 流式已渐进渲染, 仅收尾换行
      } else {
        const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        deps.log(`[loop] 助手回复: ${text.split("\n")[0].slice(0, 100)}`);
      }
      deps.emit?.({ kind: "stop" });
      return state;
    }

    if (streamed) deps.renderDelta?.("\n"); // 工具调用前收尾换行(流式文本已渐进渲染)

    // ── 分支③: 工具调用分发 ──
    // 参考原版架构: 同轮多个 tool_use 并行执行(原版架构有并发上限与编辑互斥锁, 此处全并行简化);
    // 结果按 toolUses 序收集 → 消息树/transcript/cache 字节稳定
    // 中断语义: signal 触发时, 未开始的工具跳过、执行中的工具尽快终止, 全部以 error 结果入树
    // (tool_use 必须有配对的 tool_result, 否则消息树对 API 无效)
    const sig = deps.signal;
    const runOne = async (tu: ToolUseBlock): Promise<ToolResultBlock> => {
      deps.emit?.({ kind: "tool_start", id: tu.id, name: tu.name, input: tu.input });
      if (sig?.aborted) {
        return { type: "tool_result", tool_use_id: tu.id, content: "用户中断, 未执行", is_error: true };
      }
      const tool = deps.tools.get(tu.name);
      if (!tool) {
        deps.telemetry?.recordToolError(); // 遥测: 未知工具(权限拒绝/中断不计 — 正常工作流)
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `未知工具: ${tu.name}`,
          is_error: true,
        };
      }
      // 形状校验前置: 垃圾输入不进权限瀑布/不弹窗/不跑 PostToolUse, 也不派生错误记忆规则
      // (如 command: null 会被 String() 转成 "null" 记忆出 Bash(null:*)); 失败以 error 结果
      // 入树 → 模型下一轮自修正(tool_use 必有配对 tool_result, 消息树一致性)
      const issues = validateToolInput(tool.inputSchema, tu.input);
      if (issues.length > 0) {
        deps.telemetry?.recordToolError(); // 遥测: 模型坏调用(同未知工具口径; 权限拒绝/中断不计)
        deps.log(`[validate] ${tu.name} 输入校验失败: ${issues.map((i) => `${i.field}: ${i.problem}`).join("; ")}`);
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: formatValidationIssues(tu.name, tool.inputSchema, tu.input, issues),
          is_error: true,
        };
      }
      try {
        // 权限瀑布(deny 规则 → 静态检查 → PreToolUse Hook → bypass → ask/allow 规则 → 分类器 → 用户)
        // 弹窗等待/分类器查询均与 signal race → 中断即拒
        const perm = await deps.permissions.check(tool, tu.input, deps.getUserMessages(), sig);
        deps.emit?.({ kind: "perm", id: tu.id, decision: perm.decision, source: perm.source, reason: perm.reason });
        deps.log(
          `[perm] ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)}) → ${perm.decision.toUpperCase()} ` +
          `(${perm.source}: ${perm.reason.slice(0, 90)})`
        );
        if (perm.decision !== "allow") {
          // 权限拒绝处理: Hook 拒绝 → hook-blocking-error(系统提示声明: Hook 反馈视作用户本人反馈)
          const isHook = perm.source === "hook";
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            is_error: true,
            content: isHook
              ? `hook-blocking-error: ${perm.reason}\n该操作被 PreToolUse Hook 拒绝。Hook 反馈视作用户本人反馈, 请换一种方法达成目标。`
              : `permission denied: ${perm.reason}\n请换一种方法, 或向用户说明需要手动执行。`,
          };
        }
        // 执行与中断 race: 工具自行响应 signal(如 Bash kill 子进程); 不响应时由 race 兜底
        const exec = sig
          ? await Promise.race([
              tool.execute(tu.input, { signal: sig }),
              new Promise<{ content: string; isError?: boolean }>((resolve) =>
                sig.addEventListener("abort", () => resolve({ content: "用户中断, 工具中止", isError: true }), { once: true })
              ),
            ])
          : await tool.execute(tu.input);
        if (exec.isError) deps.telemetry?.recordToolError(); // 遥测: 工具执行失败(计数不落盘)
        // 诊断回灌: 验证类命令结果入缓冲(成功消解/失败 upsert) → 下一条用户消息注入提醒
        if (tu.name === "Bash") {
          const bashCmd = (tu.input as { command?: unknown }).command;
          if (typeof bashCmd === "string") deps.diagnostics?.record(bashCmd, !exec.isError, exec.content);
        }
        await deps.hooks.run("PostToolUse", { toolName: tu.name, toolInput: tu.input }, sess);
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: exec.content,
          is_error: exec.isError,
        };
      } catch (e) {
        // 中断传播为 error 结果(而不是异常逃逸): 保证本轮 tool_use 全部有配对 tool_result
        if (e instanceof RunAbortedError) {
          return { type: "tool_result", tool_use_id: tu.id, content: "用户中断", is_error: true };
        }
        throw e;
      }
    };
    // 并发上限(参考原版架构): 同轮 tool_use 并行执行, 超过上限的排队等待(防资源耗尽);
    // 同文件的 Edit/Write 由 fileState 文件锁互斥; 结果仍按 toolUses 序收集 → 消息树稳定
    const MAX_PARALLEL_TOOLS = 4;
    let active = 0;
    const slotQ: Array<() => void> = [];
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (active < MAX_PARALLEL_TOOLS) {
          active++;
          resolve();
        } else slotQ.push(() => { active++; resolve(); });
      });
    const release = () => {
      active--;
      slotQ.shift()?.();
    };
    const results: ToolResultBlock[] = await Promise.all(
      toolUses.map(async (tu) => {
        await acquire();
        try {
          return await runOne(tu);
        } finally {
          release();
        }
      })
    );
    // 结果统一外发(覆盖: 正常执行 / 权限拒绝 / 未知工具)
    results.forEach((r, i) => {
      deps.emit?.({
        kind: "tool_result",
        id: r.tool_use_id,
        name: toolUses[i].name,
        output: r.content,
        isError: r.is_error === true,
      });
    });

    // T0 工具结果预算: 结果入树时应用(替换串冻结 → 字节级一致, 保 cache)
    const t0 = enforceToolResultBudget([{ role: "user", content: results }], deps.cfg, deps.artifactsDir);
    if (t0.budgeted > 0) {
      deps.emit?.({ kind: "compact", level: "T0", detail: `${t0.budgeted} 个工具结果超预算 → 落盘 + 预览注入` });
      deps.log(
        `[compact] T0 budget: ${t0.budgeted} 个工具结果超 ${deps.cfg.toolResultBudget} tokens → 落盘 + 预览注入(替换串冻结)`
      );
    }
    state.archivedFiles.push(...t0.archivedFiles);
    state.messages.push(t0.messages[0]);
    appendTranscript(deps, t0.messages[0]);
    // 中断: 消息树已一致(本轮全部 tool_use 有配对 tool_result), 到此收尾抛中断
    if (sig?.aborted) throw new RunAbortedError();
  }
  throw new Error(`runQuery: 超过最大轮次守卫(${turns} 轮; settings.json engine.maxTurns 可调)`);
}
