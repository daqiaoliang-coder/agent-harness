// 权限弹窗预览构建 — 人工确认层的人类可读化(架构参考: 的 diff 预览 + "don't ask again" 会话规则)。
// - buildPermissionPreview: Edit/Write 在权限时刻渲染 diff 预览(其他工具 undefined → UI 回落 JSON)
// - deriveAlwaysRule: 用户选"总是允许"时推导记住的规则字符串(语法同 settings 规则, 由 matchRule 消费)
// 约束: 只读文件内容做预览, 绝不触碰 fileState(markRead/markWritten) —
// 防止权限层的读"虚假满足"Edit 的先读后改校验(硬约束); 只读不改 mtime, 不影响新鲜度。
import * as fs from "fs";
import * as path from "path";
import { normalizeForAllow } from "./rules";

export interface PreviewLine {
  op: "ctx" | "del" | "add";
  text: string;
}

export interface PermissionPreview {
  type: "edit" | "write-new" | "write-overwrite";
  path: string;
  lines: PreviewLine[];
  note?: string;
}

const MAX_PREVIEW_LINES = 30;
const CONTEXT_LINES = 3;

// Edit/Write 弹窗预览; 其他工具返回 undefined(前端回落 JSON 渲染)
export function buildPermissionPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string
): PermissionPreview | undefined {
  if ((toolName !== "Edit" && toolName !== "Write") || !String(toolInput.path ?? "")) return undefined;
  const p = path.resolve(cwd, String(toolInput.path));
  return toolName === "Edit" ? buildEditPreview(p, toolInput) : buildWritePreview(p, toolInput);
}

// Edit: 定位 old_string 首次出现, 前后各 CONTEXT_LINES 行上下文 + del(旧)/add(新); 附执行风险提示
function buildEditPreview(p: string, toolInput: Record<string, unknown>): PermissionPreview {
  const oldStr = String(toolInput.old_string ?? "");
  const newStr = String(toolInput.new_string ?? "");
  if (!oldStr) return { type: "edit", path: p, lines: [], note: "缺少 old_string(执行将失败)" };
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return { type: "edit", path: p, lines: [], note: "文件不存在或不可读(执行将失败)" };
  }
  const notes: string[] = [];
  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    notes.push("old_string 未在文件中找到(须逐字符精确匹配, 执行将失败)");
  } else if (count > 1 && toolInput.replace_all !== true) {
    notes.push(`old_string 出现 ${count} 次(需唯一, 执行将失败; 可加长匹配串或 replace_all)`);
  }
  const lines: PreviewLine[] = [];
  const idx = count > 0 ? content.indexOf(oldStr) : -1;
  if (idx >= 0) {
    const all = content.split("\n");
    const startLine = content.slice(0, idx).split("\n").length - 1; // 命中起始行(0 基)
    const oldLines = oldStr.split("\n");
    const endLine = startLine + oldLines.length - 1;
    for (let i = Math.max(0, startLine - CONTEXT_LINES); i < startLine; i++) lines.push({ op: "ctx", text: all[i] });
    for (const l of oldLines) lines.push({ op: "del", text: l });
    for (const l of newStr.split("\n")) lines.push({ op: "add", text: l });
    for (let i = endLine + 1; i <= Math.min(all.length - 1, endLine + CONTEXT_LINES); i++) {
      lines.push({ op: "ctx", text: all[i] });
    }
  }
  return finalize({ type: "edit", path: p, lines, note: notes.join("; ") || undefined });
}

// Write: 新文件展示前 MAX 行; 覆盖时公共前后缀行裁剪, 中间 del(旧)/add(新)
function buildWritePreview(p: string, toolInput: Record<string, unknown>): PermissionPreview {
  const content = String(toolInput.content ?? "");
  let old: string | null = null;
  try {
    old = fs.readFileSync(p, "utf8");
  } catch {
    old = null; // 不存在/不可读 → 按新文件展示
  }
  const newLines = content.split("\n");
  if (old === null) {
    return finalize({
      type: "write-new",
      path: p,
      lines: newLines.slice(0, MAX_PREVIEW_LINES).map((l) => ({ op: "add" as const, text: l })),
      note: `新文件(共 ${newLines.length} 行)${newLines.length > MAX_PREVIEW_LINES ? `; 仅展示前 ${MAX_PREVIEW_LINES} 行` : ""}`,
    });
  }
  const a = old.split("\n");
  const b = newLines;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const lines: PreviewLine[] = [];
  for (let i = Math.max(0, pre - CONTEXT_LINES); i < pre; i++) lines.push({ op: "ctx", text: a[i] });
  for (let i = pre; i < a.length - suf; i++) lines.push({ op: "del", text: a[i] });
  for (let i = pre; i < b.length - suf; i++) lines.push({ op: "add", text: b[i] });
  for (let i = suf - 1; i >= 0; i--) lines.push({ op: "ctx", text: a[a.length - 1 - i] });
  return finalize({
    type: "write-overwrite",
    path: p,
    lines,
    note: `覆盖已有文件: ${a.length} 行 → ${b.length} 行`,
  });
}

function finalize(pv: PermissionPreview): PermissionPreview {
  if (pv.lines.length > MAX_PREVIEW_LINES) {
    const dropped = pv.lines.length - MAX_PREVIEW_LINES;
    pv.lines = pv.lines.slice(0, MAX_PREVIEW_LINES);
    const note = `预览截断(另有 ${dropped} 行)`;
    pv.note = pv.note ? `${pv.note}; ${note}` : note;
  }
  return pv;
}

// 推导"总是允许"将记住的规则字符串(语法同 settings 权限规则, 由 matchRule 消费)
export function deriveAlwaysRule(
  toolName: string,
  toolInput: Record<string, unknown>
): string | undefined {
  if (toolName !== "Bash") return toolName; // 工具级: Edit / Write / mcp__server__tool(任意参数)
  const raw = String(toolInput.command ?? "").trim();
  if (!raw) return undefined;
  // 含 shell 操作符/替换的复合命令: 只记完整命令本身(前缀 = 全命令, 不放行拼接命令)。
  // 用 ":*" 后缀而非裸括号: parseRule 按 lastIndexOf(":") 切前缀, 命令内含冒号时裸括号形式
  // 会被错误截断成更宽前缀(如 Bash(echo a:b && ls) → 前缀 "echo a"); ":*" 保证切在末尾。
  // 引号内操作符误判只会回落到本保守分支, 安全方向。
  if (/[;&|<>`]|\$\(/.test(raw)) return `Bash(${raw}:*)`;
  // 与 matchRule allow 路径同一规范化(env 前缀剥离), 否则记住的规则匹配不上
  const normalized = normalizeForAllow(raw);
  if (!normalized) return undefined;
  const tokens = normalized.split(/\s+/);
  // 首 token + 非 flag 第二 token: git push origin main → git push / ls -la → ls
  const prefix = tokens[1] && !tokens[1].startsWith("-") ? `${tokens[0]} ${tokens[1]}` : tokens[0];
  return `Bash(${prefix}:*)`;
}
