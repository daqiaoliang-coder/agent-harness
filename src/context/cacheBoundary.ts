// 架构参考:的 prompt cache 边界设计 — 稳定前缀(system + tools)与动态部分(messages)
// 之间划一条字节级稳定的生产者/消费者边界, 前缀不变即可命中服务端 KV cache
import { createHash } from "crypto";
import { Message } from "../types";

// 确定性序列化: 键排序 + 固定分隔符 + 无时间戳/随机数
// (CacheSafeParams 的前提: 相同逻辑内容 → 相同字节 → cache 前缀可复用)
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  if (value === undefined) return "null";
  return JSON.stringify(value) as string;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// 进入请求体的参数必须"缓存安全": 不含时间戳、随机数、迭代顺序不稳定的数据结构
export interface CacheSafeParams {
  model: string;
  system: string[];
  tools: ToolSchema[];
  messages: Message[];
  max_tokens: number;
}

// DYNAMIC BOUNDARY 标记: 稳定前缀与动态部分的分界线
export const DYNAMIC_BOUNDARY = "\n<<<DYNAMIC BOUNDARY>>>\n";

export interface BuiltRequest {
  // 稳定前缀的指纹(模拟 cache_control 断点): 相同 key → 服务端前缀复用
  prefixKey: string;
  body: string;
}

export function buildRequest(p: CacheSafeParams): BuiltRequest {
  const prefix = stableStringify({
    max_tokens: p.max_tokens,
    model: p.model,
    system: p.system,
    tools: p.tools,
  });
  const dynamic = stableStringify({ messages: p.messages });
  return {
    prefixKey: createHash("sha256").update(prefix).digest("hex").slice(0, 16),
    body: prefix + DYNAMIC_BOUNDARY + dynamic,
  };
}
