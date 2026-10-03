// 会话管理共享层(标题派生 / 跨会话搜索 / markdown 导出 / transcript fork)
// Web server 与 CLI sessions 子命令复用; 全部直接读 sessions/*.jsonl 落盘文件 — 无需激活会话。
// 标题不落盘: 由首条用户消息实时派生(零 schema 变更, 永不与 transcript 脱同步)。
import * as fs from "fs";
import * as path from "path";
import { Message } from "../types";
import { loadTranscript } from "./resume";

// 头部预读上限: 标题只需首条用户消息, 大会话不整读(参考实现务实取舍)
const TITLE_HEAD_BYTES = 64 * 1024;
const TITLE_MAX_CHARS = 60;

export interface SessionInfo {
  id: string;
  mtime: number;
  size: number;
  title: string;
}

function sessionFile(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id.replace(/\.jsonl$/, "")}.jsonl`);
}

export function listSessionFiles(sessionsDir: string): Array<{ id: string; file: string; mtime: number; size: number }> {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const st = fs.statSync(path.join(sessionsDir, f));
      return { id: f.replace(/\.jsonl$/, ""), file: path.join(sessionsDir, f), mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// 标题 = 首条用户消息首行截断(读头部即可; 无用户消息 → "(空会话)")
export function deriveTitle(file: string): string {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(TITLE_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, TITLE_HEAD_BYTES, 0);
      head = buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "(不可读)";
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { role?: string; content?: Array<{ type: string; text?: string }> };
      if (rec.role !== "user" || !Array.isArray(rec.content)) continue;
      const text = rec.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) continue; // 纯 tool_result 行(修复补齐等) → 继续找真正的用户输入
      const firstLine = text.split("\n")[0];
      return firstLine.length > TITLE_MAX_CHARS ? `${firstLine.slice(0, TITLE_MAX_CHARS)}…` : firstLine;
    } catch {
      continue; // 坏行(截断的末行等)跳过
    }
  }
  return "(空会话)";
}

export function listSessions(sessionsDir: string): SessionInfo[] {
  return listSessionFiles(sessionsDir).map(({ id, file, mtime, size }) => ({ id, mtime, size, title: deriveTitle(file) }));
}

// ── 跨会话搜索: 大小写不敏感子串; 只搜用户输入与 assistant 文本块(工具 I/O 噪音大, 不入结果) ──
export interface SearchHit {
  role: "user" | "assistant";
  ts?: string;
  snippet: string; // 命中上下文 ±80 字符
}
export interface SessionSearchResult {
  sessionId: string;
  title: string;
  mtime: number;
  hits: SearchHit[];
}
const SNIPPET_CTX = 80;
const MAX_HITS_PER_SESSION = 5;
const MAX_SESSIONS = 20;

export function searchSessions(sessionsDir: string, query: string): { query: string; results: SessionSearchResult[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { query, results: [] };
  const results: SessionSearchResult[] = [];
  for (const { id, file, mtime } of listSessionFiles(sessionsDir)) {
    if (results.length >= MAX_SESSIONS) break;
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hits: SearchHit[] = [];
    for (const line of raw.split("\n")) {
      if (hits.length >= MAX_HITS_PER_SESSION) break;
      if (!line.toLowerCase().includes(q)) continue; // 快路径: 行级包含才解析
      let rec: { ts?: string; role?: string; content?: Array<{ type: string; text?: string }> };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.role !== "user" && rec.role !== "assistant") continue;
      const texts = (rec.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      const text = texts.join("\n");
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue; // 命中在工具块等非文本位置 → 不算
      const start = Math.max(0, at - SNIPPET_CTX);
      const snippet =
        (start > 0 ? "…" : "") + text.slice(start, at + q.length + SNIPPET_CTX) + (at + q.length + SNIPPET_CTX < text.length ? "…" : "");
      hits.push({ role: rec.role, ts: rec.ts, snippet: snippet.replace(/\s+/g, " ") });
    }
    if (hits.length > 0) results.push({ sessionId: id, title: deriveTitle(file), mtime, hits });
  }
  return { query, results };
}

// ── markdown 导出: 线性渲染消息树(user 文本/assistant 文本/工具调用与结果按 transcript 序) ──
const EXPORT_RESULT_PREVIEW = 2000;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function exportSessionMarkdown(sessionsDir: string, sessionId: string): string {
  const file = sessionFile(sessionsDir, sessionId);
  if (!fs.existsSync(file)) throw new Error(`会话不存在: ${sessionId}`);
  const { messages } = loadTranscript(file);
  const lines: string[] = [
    `# agent-harness 会话导出: ${sessionId}`,
    "",
    `- 消息: ${messages.length} 条 | 导出时间: ${new Date().toISOString()}`,
    "",
  ];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") {
        lines.push(m.role === "user" ? "## 👤 用户" : "## 🤖 助手", "", b.text, "");
      } else if (b.type === "tool_use") {
        lines.push(`### ⚙ 工具调用: ${b.name}`, "", "```json", JSON.stringify(b.input, null, 2), "```", "");
      } else if (b.type === "tool_result") {
        const text = resultText(b.content);
        const body = text.length > EXPORT_RESULT_PREVIEW ? `${text.slice(0, EXPORT_RESULT_PREVIEW)}\n…(截断, 共 ${text.length} 字符)` : text;
        lines.push(`<details><summary>↳ 工具结果${b.is_error ? "(错误)" : ""}</summary>`, "", "```", body, "```", "", "</details>", "");
      }
    }
  }
  return lines.join("\n");
}

export function exportSessionJsonl(sessionsDir: string, sessionId: string): string {
  const file = sessionFile(sessionsDir, sessionId);
  if (!fs.existsSync(file)) throw new Error(`会话不存在: ${sessionId}`);
  return fs.readFileSync(file, "utf8");
}

// ── fork: 复制 transcript(可截断至前 N 条消息)开新会话 ──
// 崩溃一致性免费获得: 新会话激活走 createSession(resume) → repairTranscript 自动修孤儿块。
export function forkTranscript(sessionsDir: string, sourceId: string, newId: string, opts: { upto?: number } = {}): { id: string; messages: number } {
  const src = sessionFile(sessionsDir, sourceId);
  if (!fs.existsSync(src)) throw new Error(`源会话不存在: ${sourceId}`);
  const dst = sessionFile(sessionsDir, newId);
  if (fs.existsSync(dst)) throw new Error(`目标会话已存在: ${newId}`);
  const raw = fs.readFileSync(src, "utf8");
  let kept = 0;
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { role?: string };
      if (rec.role !== "user" && rec.role !== "assistant") continue;
      if (opts.upto !== undefined && kept >= opts.upto) break;
      kept++;
      out.push(line);
    } catch {
      continue; // 坏行不复制(新会话激活时 repair 兜底)
    }
  }
  fs.writeFileSync(dst, out.length > 0 ? out.join("\n") + "\n" : "", "utf8");
  return { id: newId, messages: kept };
}
