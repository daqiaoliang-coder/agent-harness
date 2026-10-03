// 架构参考: Claude Code WebSearch — 联网搜索工具(只读网络操作, 静态 allow 免弹窗)。
// 执行位置为客户端本地工具(与 Bash 同模式): 走注册表/权限瀑布/主循环/中止全链, SearchFn 注入式可替换(测试/换后端)。
// 默认后端 DuckDuckGo html 端点(零 key 即用), 正则解析 best-effort — 失败报 HTTP/解析错误, 不静默吞。
// 超时/中止/输出上限对齐 bash.ts 先例: 越界报错不 clamp, abort → "[aborted by user]", 硬上限截断 + 尾注。
import { ToolResult } from "../types";
import { Tool, ToolContext } from "./tool";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 15_000; // 固定超时(参数面最小化: 搜索应快速返回, 不给模型可调 timeout)
const MAX_OUTPUT_CHARS = 16_000; // 硬上限(T0 预算层之前先兜底)

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// 搜索后端抽象: query → 结果列表; signal/timeoutMs 由调用方统一注入
export type SearchFn = (
  query: string,
  opts: { maxResults: number; timeoutMs: number; signal?: AbortSignal }
) => Promise<WebSearchResult[]>;

// DuckDuckGo 重定向链接解码: href 形如 //duckduckgo.com/l/?uddg=<urlencoded>&rut=…
function decodeDuckUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (!m) return href.startsWith("http") ? href : "";
  try {
    const decoded = decodeURIComponent(m[1]);
    return decoded.startsWith("http") ? decoded : "";
  } catch {
    return "";
  }
}

// 去标签 + 常见 HTML 实体解码 + 空白折叠
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 纯函数解析(导出供单测, 无网络): result__a 标题/链接按序配对 result__snippet 摘要
export function parseDuckHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const url = decodeDuckUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    results.push({ title, url, snippet: "" });
  }
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/g;
  let i = 0;
  let s: RegExpExecArray | null;
  while ((s = snipRe.exec(html)) !== null && i < results.length) {
    results[i].snippet = stripTags(s[1]);
    i++;
  }
  return results;
}

// 默认后端: DuckDuckGo html 端点(零 key); fetch + AbortController 组合 超时 与 用户中止
export async function duckDuckGoSearch(
  query: string,
  opts: { maxResults: number; timeoutMs: number; signal?: AbortSignal }
): Promise<WebSearchResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (agent-harness WebSearch)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDuckHtml(await res.text(), opts.maxResults);
  } catch (e) {
    if (opts.signal?.aborted) throw e; // 用户中止交由 execute 统一译为 [aborted by user]
    throw new Error(
      `DuckDuckGo 请求失败: ${(e as Error).name === "AbortError" ? `${opts.timeoutMs}ms 超时` : (e as Error).message}`,
      { cause: e }
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export class WebSearchTool implements Tool {
  readonly name = "WebSearch";
  readonly description = "联网搜索(DuckDuckGo), 返回编号的标题/链接/摘要列表";
  readonly inputSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      max_results: { type: "number", description: `返回条数上限(默认 ${DEFAULT_MAX_RESULTS}, 1-${MAX_RESULTS_LIMIT})` },
    },
    required: ["query"],
  };

  constructor(private readonly opts?: { search?: SearchFn; log?: (line: string) => void }) {}

  checkPermissions() {
    // 只读网络搜索 → 瀑布第②层直接放行(deny 规则/PreToolUse Hook 在前层仍可拦; plan 模式放行)
    return { decision: "allow" as const, reason: "WebSearch 为只读联网搜索" };
  }

  async execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    // 调度层 validator 已拦"缺失"(required); 此处拦"显式空串"(两层分工, 对齐 Bash command 先例)
    const query = String(input.query ?? "");
    if (!query.trim()) return { content: "参数错误: query 不能为空", isError: true };
    // max_results: 调度层已保证 number(若传); 此处直调保险 + 越界报错而非 clamp(静默 clamp 会让模型误以为自己的值生效了)
    let maxResults = DEFAULT_MAX_RESULTS;
    if (input.max_results !== undefined && input.max_results !== null) {
      const n = Number(input.max_results);
      if (!Number.isInteger(n) || n < 1 || n > MAX_RESULTS_LIMIT) {
        return {
          content: `参数错误: max_results 须为 1-${MAX_RESULTS_LIMIT} 的整数(收到 ${JSON.stringify(input.max_results)})`,
          isError: true,
        };
      }
      maxResults = n;
    }

    const search = this.opts?.search ?? duckDuckGoSearch;
    // 预先中止: 不发起请求(Bash 同款)
    if (ctx?.signal?.aborted) return { content: "[aborted by user]", isError: true };
    let results: WebSearchResult[];
    try {
      results = await search(query, { maxResults, timeoutMs: SEARCH_TIMEOUT_MS, signal: ctx?.signal });
    } catch (e) {
      // 执行中中止: 交由主循环统一收尾, 不计入工具失败语义
      if (ctx?.signal?.aborted) return { content: "[aborted by user]", isError: true };
      return { content: `WebSearch 失败(query=${JSON.stringify(query)}): ${(e as Error).message}`, isError: true };
    }

    if (results.length === 0) return { content: `未找到与 ${JSON.stringify(query)} 相关的结果` };
    const body = results
      .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}${r.snippet ? `\n    ${r.snippet}` : ""}`)
      .join("\n\n");
    const stat = `\n\n(共 ${results.length} 条结果, 来源: DuckDuckGo)`;
    const content = body.length + stat.length > MAX_OUTPUT_CHARS
      ? body.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated at 16K chars]"
      : body + stat;
    this.opts?.log?.(`[WebSearch] ${JSON.stringify(query)} → ${results.length} 条`);
    return { content };
  }
}
