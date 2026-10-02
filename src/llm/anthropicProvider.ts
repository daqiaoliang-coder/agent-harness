// 架构参考:的 Anthropic SDK 封装(流式 + 完整重试矩阵); 此处零依赖 fetch 实现
// - 稳定前缀写入 cache_control 断点(system 末块) — cacheBoundary 模拟的真实化
// - completeStream: SSE 事件流解析(text_delta / input_json_delta 聚合为完整 message)
// - 413 / prompt_too_long → ContextWindowExceededError(接通 T5 reactive compact 的真实路径)
// - 429/5xx/529/网络错误(连接阶段) → 指数退避重试; 其余错误直接抛出
// - completeStream 三阶段重试(连接/非 200/零 delta 中途断流); 已渲染 delta 后断流不重试
// - buildBody 三 cache 断点: system 末块 + tools 末尾 + 消息历史稳定边界(cacheBreakpoint)
import { ContentBlock, Message, RunAbortedError } from "../types";
import { CompleteOptions, CompleteResult, ContextWindowExceededError, LLMProvider, StreamOptions, UsageInfo } from "./provider";
import { ToolSchema } from "../context/cacheBoundary";

export interface AnthropicProviderOptions {
  apiKey?: string; // 默认 process.env.ANTHROPIC_API_KEY
  model?: string; // 默认 process.env.ANTHROPIC_MODEL ?? claude-sonnet-4-5
  baseURL?: string; // 默认 process.env.ANTHROPIC_BASE_URL(兼容网关)
  maxRetries?: number; // 默认 2
  log?: (line: string) => void;
}

const RETRIABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const REQUEST_TIMEOUT_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 组合信号: 外部中断(用户) 与 请求超时 任一触发即中止 fetch
function combinedSignal(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (!external) return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  const onAbort = () => ctrl.abort();
  if (external.aborted) ctrl.abort();
  else external.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      external.removeEventListener("abort", onAbort);
    },
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly log: (line: string) => void;
  lastUsage?: UsageInfo;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!this.apiKey) throw new Error("缺少 ANTHROPIC_API_KEY(chat 模式必需; demo 模式用 MockProvider)");
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    this.baseURL = (
      opts.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
    ).replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 2;
    this.name = `anthropic:${this.model}`;
    this.log = opts.log ?? (() => {});
  }

  private buildBody(
    system: string[],
    messages: Message[],
    opts: CompleteOptions,
    stream: boolean
  ): Record<string, unknown> {
    // 请求体三断点(Anthropic 上限 4, 此处 3 覆盖全部收益):
    //   断点 1: system 末块 ephemeral(稳定前缀 = system + tools, 与 cacheBoundary 划分一致)
    //   断点 2: tools 数组末尾(工具定义会话内不变)
    //   断点 3: opts.cacheBreakpoint 指定索引处消息的末 content block(消息历史稳定边界)
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens,
      system: [{ type: "text", text: system.join("\n"), cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (stream) body.stream = true;
    if (opts.tools && opts.tools.length > 0) {
      const n = opts.tools.length;
      body.tools = opts.tools.map((t: ToolSchema, i: number) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        ...(i === n - 1 ? { cache_control: { type: "ephemeral" } } : {}), // 断点 2
      }));
    }
    // 断点 3: 深拷贝目标消息的末块加 cache_control(浅拷贝块对象即可 — 只增键不改嵌套字段, 不污染消息树)
    const bp = opts.cacheBreakpoint;
    if (bp != null && bp >= 0 && bp < messages.length) {
      const msgs = body.messages as Array<{ role: string; content: ContentBlock[] }>;
      const blocks = msgs[bp].content;
      if (blocks.length > 0) {
        msgs[bp] = {
          ...msgs[bp],
          content: blocks.map((b, i) =>
            i === blocks.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b
          ),
        };
      }
    }
    return body;
  }

  // 非流式响应
  async complete(system: string[], messages: Message[], opts: CompleteOptions): Promise<CompleteResult> {
    const body = this.buildBody(system, messages, opts, false);

    let lastErr: Error = new Error("AnthropicProvider: 不可达");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      const cs = combinedSignal(opts.signal, REQUEST_TIMEOUT_MS);
      try {
        res = await fetch(`${this.baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: cs.signal,
        });
      } catch (e) {
        // 用户中断 → 不重试, 直接抛 RunAbortedError
        if (opts.signal?.aborted) throw new RunAbortedError();
        // 网络层错误(连接拒绝/超时/中断)→ 可重试
        lastErr = new Error(`Anthropic 网络错误: ${(e as Error).message}`);
        if (attempt < this.maxRetries) {
          await this.backoff(attempt, lastErr.message);
          continue;
        }
        throw lastErr;
      } finally {
        cs.done();
      }

      if (res.ok) {
        const json = (await res.json()) as {
          content?: Array<{ type: string }>;
          usage?: UsageInfo;
        };
        this.lastUsage = json.usage;
        const content = (json.content ?? []).filter(
          (b) => b.type === "text" || b.type === "tool_use"
        ) as unknown as ContentBlock[];
        return { message: { role: "assistant", content }, usage: json.usage };
      }

      const text = await res.text().catch(() => "");
      // 413 / prompt_too_long → ContextWindowExceededError(T5 的真实触发源)
      if (res.status === 413 || text.includes("prompt_too_long")) {
        throw new ContextWindowExceededError();
      }
      if (RETRIABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        lastErr = new Error(`Anthropic API ${res.status}: ${text.slice(0, 160)}`);
        await this.backoff(attempt, lastErr.message);
        continue;
      }
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
    }
    throw lastErr;
  }

  // 流式: SSE 事件流聚合为完整 message 后返回(参考原版架构流式路径)
  // 三阶段重试矩阵(安全原则: 只在"零 delta 已渲染"时重试; 请求体逐字节相同 → 重试轮前缀照常命中):
  //   ① 连接阶段 fetch 抛错 → 恒零 delta, 网络错误退避重试(与 complete 一致)
  //   ② 非 200 阶段 → body 未消费恒零 delta, RETRIABLE 退避重试; 413 映射; 其余直接抛
  //   ③ SSE 中途断流 → emitted==0 从头重试; emitted>0 时 UI 已有渐进输出, 重试必然重复
  //      渲染 → 直接抛错结束本轮(已渲染文本保留 UI); 用户中断(RunAbortedError)优先于一切
  async completeStream(system: string[], messages: Message[], opts: StreamOptions): Promise<CompleteResult> {
    const body = this.buildBody(system, messages, opts, true);

    let lastErr: Error = new Error("AnthropicProvider: 不可达");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      const cs = combinedSignal(opts.signal, REQUEST_TIMEOUT_MS);
      try {
        res = await fetch(`${this.baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: cs.signal,
        });
      } catch (e) {
        // ① 连接阶段: 尚未渲染任何 delta → 与 complete 同款退避重试
        if (opts.signal?.aborted) throw new RunAbortedError();
        lastErr = new Error(`Anthropic 网络错误: ${(e as Error).message}`);
        if (attempt < this.maxRetries) {
          await this.backoff(attempt, lastErr.message);
          continue;
        }
        throw lastErr;
      } finally {
        cs.done();
      }

      if (!res.ok || !res.body) {
        // ② 非 200: body 未消费、零 delta 渲染 → 复用非流式错误分类(413 映射 + 可重试状态)
        const text = await res.text().catch(() => "");
        if (res.status === 413 || text.includes("prompt_too_long")) {
          throw new ContextWindowExceededError();
        }
        if (RETRIABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          lastErr = new Error(`Anthropic API ${res.status}: ${text.slice(0, 160)}`);
          await this.backoff(attempt, lastErr.message);
          continue;
        }
        throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
      }

      // ③ SSE 解析: data: {...} 行流; content_block_delta 聚合(text_delta / input_json_delta)
      // 聚合状态均为轮内局部变量 → 重试轮自然全量重置(blocks/jsonBuf/buf/emitted)
      const blocks: ContentBlock[] = [];
      const jsonBuf: string[] = []; // 每个 tool_use 块的 partial_json 累积(按 index)
      let usage: UsageInfo | undefined;
      let buf = "";
      let emitted = 0; // onTextDelta 已回调次数(>0 → UI 已有渐进输出, 不可重试)
      try {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          buf += Buffer.from(chunk).toString("utf8");
          const lines = buf.split("\n");
          buf = lines.pop() ?? ""; // 末行可能不完整, 留到下一块
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const ev = this.parseSse(line.slice(5).trim());
            if (!ev) continue;
            if (ev.type === "content_block_start" && ev.index != null && ev.content_block) {
              if (ev.content_block.type === "text") {
                blocks[ev.index] = { type: "text", text: ev.content_block.text ?? "" };
              } else if (ev.content_block.type === "tool_use") {
                blocks[ev.index] = { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} };
                jsonBuf[ev.index] = "";
              }
            } else if (ev.type === "content_block_delta" && ev.index != null && ev.delta) {
              if (ev.delta.type === "text_delta") {
                (blocks[ev.index] as { type: "text"; text: string }).text += ev.delta.text;
                if (opts.onTextDelta) {
                  opts.onTextDelta(ev.delta.text);
                  emitted++;
                }
              } else if (ev.delta.type === "input_json_delta" && ev.index != null) {
                jsonBuf[ev.index] = (jsonBuf[ev.index] ?? "") + (ev.delta.partial_json ?? "");
              }
            } else if (ev.type === "content_block_stop" && ev.index != null && jsonBuf[ev.index] !== undefined) {
              // tool_use 块结束 → 解析累积的 JSON 入参(空串 → 空 input)
              try {
                (blocks[ev.index] as { type: "tool_use"; input: Record<string, unknown> }).input = jsonBuf[ev.index]
                  ? JSON.parse(jsonBuf[ev.index])
                  : {};
              } catch {
                (blocks[ev.index] as { type: "tool_use"; input: Record<string, unknown> }).input = { _parse_error: jsonBuf[ev.index].slice(0, 200) };
              }
            } else if (ev.type === "message_start" && ev.message?.usage) {
              usage = { ...ev.message.usage };
            } else if (ev.type === "message_delta" && ev.usage) {
              usage = { ...usage, ...ev.usage }; // output_tokens 在 message_delta 才有
            }
          }
        }
      } catch (e) {
        // 中途断流: 用户中断优先(已渲染 delta 保留, 本轮以中断收尾)
        if (opts.signal?.aborted) throw new RunAbortedError();
        // 释放可能未读完的流(已断流时 cancel 会再抛, 静默)
        try { await (res.body as ReadableStream<Uint8Array>).cancel(); } catch {}
        if (emitted === 0 && attempt < this.maxRetries) {
          // 零 delta 渲染 → 从头重试绝对安全(不产生重复渲染)
          lastErr = new Error(`Anthropic 流中断(零 delta): ${(e as Error).message}`);
          await this.backoff(attempt, lastErr.message);
          continue;
        }
        throw e; // 已渲染 delta → 直接抛错结束本轮, 已渲染文本保留 UI
      }
      this.lastUsage = usage;
      return { message: { role: "assistant", content: blocks.filter(Boolean) }, usage };
    }
    throw lastErr;
  }

  // SSE data 载荷解析(容错: 坏行返回 null)
  private parseSse(payload: string): Record<string, any> | null {
    if (!payload || payload === "[DONE]") return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  private async backoff(attempt: number, why: string): Promise<void> {
    // 指数退避 + 抖动(jitter 不进请求体, 不影响 cache)
    const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
    this.log(`[llm] ${why} → ${delay}ms 后重试 (${attempt + 1}/${this.maxRetries})`);
    await sleep(delay);
  }
}
