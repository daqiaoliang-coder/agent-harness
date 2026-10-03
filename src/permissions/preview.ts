// 权限弹窗预览构建 — 人工确认层的人类可读化(架构参考: 的 diff 预览 + "don't ask again" 会话规则)。
// - buildPermissionPreview: Edit/Write 在权限时刻渲染 diff 预览(其他工具 undefined → UI 回落 JSON)
// - deriveAlwaysRule: 用户选"总是允许"时推导记住的规则字符串(语法同 settings 规则, 由 matchRule 消费)
// 约束: 只读文件内容做预览, 绝不触碰 fileState(markRead/markWritten) —
// 防止权限层的读"虚假满足"Edit 的先读后改校验(硬约束); 只读不改 mtime, 不影响新鲜度。
import * as fs from "fs";
import * as path from "path";
import { normalizeForAllow } from "./rules";
import { EditItem, applyEdits } from "../tools/edit";

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

// Edit: 单编辑定位 old_string 首次出现; 多编辑(edits 数组)按序模拟应用 — 与 execute 同一 applyEdits
// 匹配语义(弹窗所见 = 执行所得); 前后各 CONTEXT_LINES 行上下文 + del(旧)/add(新); 附执行风险提示
function buildEditPreview(p: string, toolInput: Record<string, unknown>): PermissionPreview {
  const multi = Array.isArray(toolInput.edits);
  const edits: EditItem[] = multi
    ? (toolInput.edits as unknown[]).map((it) => {
        const r = (it ?? {}) as Record<string, unknown>;
        return {
          old_string: String(r.old_string ?? ""),
          new_string: String(r.new_string ?? ""),
          replace_all: r.replace_all === true,
        };
      })
    : [
        {
          old_string: String(toolInput.old_string ?? ""),
          new_string: String(toolInput.new_string ?? ""),
          replace_all: toolInput.replace_all === true,
        },
      ];
  if (edits.length === 0 || edits.some((e) => !e.old_string)) {
    return { type: "edit", path: p, lines: [], note: "缺少 old_string(执行将失败)" };
  }
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return { type: "edit", path: p, lines: [], note: "文件不存在或不可读(执行将失败)" };
  }

  // 与执行同源的失败检测(原子性: 任一条失败整体不落盘) — 预览阶段就提示将失败
  const applied = applyEdits(content, edits);
  const notes: string[] = [];
  if (!applied.ok) {
    const at = multi ? `edits[${applied.index}] ` : "";
    if (applied.kind === "not-found") notes.push(`${at}old_string 未在文件中找到(执行将失败, 原子性保证整体不落盘)`);
    else if (applied.kind === "ambiguous") notes.push(`${at}old_string 出现 ${applied.count} 次(需唯一, 执行将失败; 可加长匹配串或 replace_all)`);
    else notes.push(`${at}old_string 与 new_string 相同(执行将失败)`);
  }

  // 逐条渲染 hunk: 定位每条在"演进中内容"的首次出现(与 applyEdits 同序), 应用后继续下一条
  const lines: PreviewLine[] = [];
  let cur = content;
  const perEditCap = Math.max(4, Math.floor(MAX_PREVIEW_LINES / edits.length)); // 多编辑时均分预览行预算
  for (let i = 0; i < edits.length && lines.length < MAX_PREVIEW_LINES; i++) {
    const e = edits[i];
    const idx = cur.indexOf(e.old_string);
    if (idx < 0) break; // 失败条已入 note; 后续条无从定位
    const all = cur.split("\n");
    const startLine = cur.slice(0, idx).split("\n").length - 1;
    const oldLines = e.old_string.split("\n");
    const endLine = startLine + oldLines.length - 1;
    const chunk: PreviewLine[] = [];
    for (let j = Math.max(0, startLine - CONTEXT_LINES); j < startLine; j++) chunk.push({ op: "ctx", text: all[j] });
    for (const l of oldLines) chunk.push({ op: "del", text: l });
    for (const l of e.new_string.split("\n")) chunk.push({ op: "add", text: l });
    for (let j = endLine + 1; j <= Math.min(all.length - 1, endLine + CONTEXT_LINES); j++) {
      chunk.push({ op: "ctx", text: all[j] });
    }
    if (multi && chunk.length > perEditCap) {
      // 单条超预算: 保留 ctx 后的前若干行, 注明截断(不让一条大编辑吞掉全部预览)
      chunk.splice(perEditCap, chunk.length, { op: "ctx", text: `…(edits[${i}] 预览截断)` });
    }
    lines.push(...chunk);
    cur = e.replace_all ? cur.split(e.old_string).join(e.new_string) : cur.replace(e.old_string, e.new_string);
  }
  if (multi) notes.push(`多编辑: ${edits.length} 条按序应用, 任一条失败整体不落盘(原子)`);
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
