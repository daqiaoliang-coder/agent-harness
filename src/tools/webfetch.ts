// 架构参考: Claude Code WebFetch — 抓取网页并转为可读文本(只读网络操作, 静态 allow 免弹窗)。
// 执行位置为客户端本地工具(与 WebSearch 同模式): 走注册表/权限瀑布/主循环/中止全链, FetchFn 注入式可替换。
// SSRF 务实防线: 仅 http/https + 主机名黑名单(回环/私网/链路本地/元数据端点), fetch 跟随重定向后
//   再校验最终 URL(res.url)— 已知局限: 不解析 DNS, 防不了 IP 直连十进制/八进制与 DNS rebinding(注释明示, 不静默)。
// HTML 转文本为纯函数(导出供单测): script/style/注释剔除 + 块级标签断行 + 实体解码 + 空白折叠。
// 超时/中止/输出上限对齐 WebSearch/bash 先例: 越界报错不 clamp, abort → "[aborted by user]", 截断加尾注。
import { ToolResult } from "../types";
import { Tool, ToolContext } from "./tool";

const DEFAULT_MAX_CHARS = 32_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 100_000; // 对齐原版 WebFetch 截断量级
const FETCH_TIMEOUT_MS = 15_000; // 固定超时(参数面最小化, 与 WebSearch 一致)

// 抓取后端抽象: url → {状态, 内容类型, 正文}; signal/timeoutMs 由调用方统一注入
export interface FetchedPage {
  status: number;
  contentType: string;
  text: string;
  finalUrl: string; // 跟随重定向后的最终地址(SSRF 二次校验用)
}
export type FetchFn = (
  url: string,
  opts: { timeoutMs: number; signal?: AbortSignal }
) => Promise<FetchedPage>;

// SSRF 主机名防线(纯函数, 导出供单测): 回环/私网/链路本地/唯一本地/元数据端点一律拒绝。
// 基于主机名字符串(不解析 DNS): 防"常用名直接打内网", 不防 DNS rebinding — 参考实现的明示取舍。
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // [::1] → ::1
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h === "metadata.google.internal") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    if (a === 127 || a === 0 || a === 10) return true; // 回环 / "0.0.0.0" / 私网 A
    if (a === 192 && Number(m[2]) === 168) return true; // 私网 C
    if (a === 172 && Number(m[2]) >= 16 && Number(m[2]) <= 31) return true; // 私网 B
    if (a === 169 && Number(m[2]) === 254) return true; // 链路本地(含云元数据 169.254.169.254)
    return false;
  }
  return false;
}

// 入口 URL 校验(纯函数): 协议白名单 + 主机名防线; 返回 null = 通过
export function validateUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `无效 URL: ${JSON.stringify(raw)}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `仅支持 http/https(收到 ${u.protocol})`;
  }
  if (isPrivateHost(u.hostname)) {
    return `目标主机 ${u.hostname} 为回环/私网/元数据地址, 已拒绝(SSRF 防线)`;
  }
  return null;
}

// HTML → 可读文本(纯函数, 导出供单测): script/style/头尾注释剔除 → 块级标签断行 → 去标签 → 实体解码 → 空白折叠
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(p|div|section|article|header|footer|nav|aside|main|table|tr|ul|ol|li|dl|dd|dt|blockquote|pre|h[1-6]|form|fieldset)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 默认后端: fetch 跟随重定向(≤20), 文本类直接返回, 其他类型也按文本读(工具层按 content-type 分流)
export async function fetchPage(
  url: string,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<FetchedPage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (agent-harness WebFetch)", accept: "text/html,text/plain,application/json,*/*" },
      redirect: "follow",
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text: await res.text(),
      finalUrl: res.url || url,
    };
  } catch (e) {
    if (opts.signal?.aborted) throw e; // 用户中止交由 execute 统一译为 [aborted by user]
    throw new Error(
      `请求失败: ${(e as Error).name === "AbortError" ? `${opts.timeoutMs}ms 超时` : (e as Error).message}`,
      { cause: e }
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export class WebFetchTool implements Tool {
  readonly name = "WebFetch";
  readonly description =
    "抓取网页/接口并返回可读文本(HTML 自动转文本; JSON/纯文本原样; 截断加尾注)。仅 http/https 且拒绝内网/元数据地址";
  readonly inputSchema = {
    type: "object",
    properties: {
      url: { type: "string", description: "目标 URL(http/https)" },
      max_chars: { type: "number", description: `返回字符数上限(默认 ${DEFAULT_MAX_CHARS}, ${MIN_MAX_CHARS}-${MAX_MAX_CHARS})` },
    },
    required: ["url"],
  };

  constructor(private readonly opts?: { fetch?: FetchFn; log?: (line: string) => void }) {}

  checkPermissions() {
    // 只读网络抓取 → 瀑布第②层直接放行(deny 规则/PreToolUse Hook 在前层仍可拦; plan 模式放行)
    return { decision: "allow" as const, reason: "WebFetch 为只读联网抓取" };
  }

  async execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const url = String(input.url ?? "");
    if (!url.trim()) return { content: "参数错误: url 不能为空", isError: true };
    // max_chars: 调度层已保证 number(若传); 此处直调保险 + 越界报错而非 clamp(对齐 WebSearch/bash 先例)
    let maxChars = DEFAULT_MAX_CHARS;
    if (input.max_chars !== undefined && input.max_chars !== null) {
      const n = Number(input.max_chars);
      if (!Number.isInteger(n) || n < MIN_MAX_CHARS || n > MAX_MAX_CHARS) {
        return {
          content: `参数错误: max_chars 须为 ${MIN_MAX_CHARS}-${MAX_MAX_CHARS} 的整数(收到 ${JSON.stringify(input.max_chars)})`,
          isError: true,
        };
      }
      maxChars = n;
    }

    const urlErr = validateUrl(url);
    if (urlErr) return { content: `WebFetch 拒绝: ${urlErr}`, isError: true };

    const doFetch = this.opts?.fetch ?? fetchPage;
    if (ctx?.signal?.aborted) return { content: "[aborted by user]", isError: true };
    let page: FetchedPage;
    try {
      page = await doFetch(url, { timeoutMs: FETCH_TIMEOUT_MS, signal: ctx?.signal });
    } catch (e) {
      if (ctx?.signal?.aborted) return { content: "[aborted by user]", isError: true };
      return { content: `WebFetch 失败(url=${JSON.stringify(url)}): ${(e as Error).message}`, isError: true };
    }

    // 重定向后二次校验最终主机(redirect: follow 不经本校验; 元数据端点常经 30x 跳转)
    let finalHost = url;
    try {
      finalHost = new URL(page.finalUrl).hostname;
    } catch { /* 保持原 url 再验一次 */ }
    const finalErr = validateUrl(page.finalUrl);
    if (finalErr) return { content: `WebFetch 拒绝: 重定向最终地址 ${page.finalUrl} 未过内网防线(${finalHost})`, isError: true };

    if (page.status >= 400) {
      return { content: `HTTP ${page.status}(${page.finalUrl}); 正文前 200 字符:\n${page.text.slice(0, 200)}`, isError: true };
    }

    // content-type 分流: HTML → 转文本; JSON/纯文本 → 原样(保留结构供模型解析)
    const ct = page.contentType.toLowerCase();
    const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
    const body = isHtml ? htmlToText(page.text) : page.text;

    const head = `(${page.finalUrl}${isHtml ? " [html→text]" : ""})\n\n`;
    if (head.length + body.length <= maxChars) {
      this.opts?.log?.(`[WebFetch] ${JSON.stringify(url)} → ${page.status} ${body.length} chars`);
      return { content: head + body };
    }
    const room = Math.max(0, maxChars - head.length);
    this.opts?.log?.(`[WebFetch] ${JSON.stringify(url)} → ${page.status} ${body.length} chars(截断至 ${room})`);
    return { content: head + body.slice(0, room) + `\n[output truncated at ${maxChars} chars]` };
  }
}
