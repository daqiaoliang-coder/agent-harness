// 架构参考:的 Anthropic SDK 封装(流式 + 完整重试矩阵); 此处零依赖 fetch 实现
// - 稳定前缀写入 cache_control 断点(system 末块) — cacheBoundary 模拟的真实化
// - completeStream: SSE 事件流解析(text_delta / input_json_delta 聚合为完整 message)
// - 413 / prompt_too_long → ContextWindowExceededError(接通 T5 reactive compact 的真实路径)
// - 429/5xx/529/网络错误(连接阶段) → 指数退避重试; 其余错误直接抛出
import { ContentBlock, Message } from "../types";
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
    // 请求体: system 合并为单块并打 cache_control 断点 — 稳定前缀 = system + tools,
    // 与 cacheBoundary.buildRequest 的 DYNAMIC BOUNDARY 划分一致
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens,
      system: [{ type: "text", text: system.join("\n"), cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (stream) body.stream = true;
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t: ToolSchema) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }
    return body;
  }

  // 非流式响应
  async complete(system: string[], messages: Message[], opts: CompleteOptions): Promise<CompleteResult> {
    const body = this.buildBody(system, messages, opts, false);

    let lastErr: Error = new Error("AnthropicProvider: 不可达");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        // 网络层错误(连接拒绝/超时/中断)→ 可重试
        lastErr = new Error(`Anthropic 网络错误: ${(e as Error).message}`);
        if (attempt < this.maxRetries) {
          await this.backoff(attempt, lastErr.message);
          continue;
        }
        throw lastErr;
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
  async completeStream(system: string[], messages: Message[], opts: StreamOptions): Promise<CompleteResult> {
    const body = this.buildBody(system, messages, opts, true);
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Anthropic 网络错误: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      // 非 200: 复用非流式的错误分类(413 映射; 流式路径不重试 — 避免已渲染 delta 重复)
      const text = await res.text().catch(() => "");
      if (res.status === 413 || text.includes("prompt_too_long")) {
        throw new ContextWindowExceededError();
      }
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
    }

    // SSE 解析: data: {...} 行流; content_block_delta 聚合(text_delta / input_json_delta)
    const blocks: ContentBlock[] = [];
    const jsonBuf: string[] = []; // 每个 tool_use 块的 partial_json 累积(按 index)
    let usage: UsageInfo | undefined;
    let buf = "";
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
            opts.onTextDelta?.(ev.delta.text);
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
    this.lastUsage = usage;
    return { message: { role: "assistant", content: blocks.filter(Boolean) }, usage };
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
