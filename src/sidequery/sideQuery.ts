// 对照: 侧查询(压缩摘要/分类器/折叠)复用同一 API — 非流式, maxTokens=1024, 失败重试 2 次
import { Message } from "../types";
import { LLMProvider } from "../llm/provider";

export interface SideQueryOptions {
  maxTokens?: number;
  retries?: number;
  log?: (line: string) => void;
}

export async function sideQuery(
  provider: LLMProvider,
  system: string[],
  messages: Message[],
  opts: SideQueryOptions = {}
): Promise<string> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await provider.complete(system, messages, { maxTokens: opts.maxTokens ?? 1024 });
      return r.message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    } catch (e) {
      if (attempt >= retries) throw e;
      opts.log?.(`[side] 查询失败, 重试 ${attempt + 1}/${retries}: ${(e as Error).message}`);
    }
  }
}
