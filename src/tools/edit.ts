// 架构参考: Edit 工具 — 精确字符串替换(逐字符匹配, 含缩进)
// + 先读后改(必须先 Read) + 编辑新鲜度校验(Read 后被外部修改则拒绝)
// + 多编辑模式(原 MultiEdit 语义并入): edits 数组按序应用, 任一条失败 → 整体不落盘(原子性)
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { checkFreshness, markWritten, withFileLock } from "./fileState";

// 单条编辑(normalize 后的内部形状; replace_all 可按条覆写)
export interface EditItem {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

// 应用结果(纯函数, execute 与权限预览共用 — 预览必须与执行同一套匹配语义, 否则弹窗所见非所得)
export type ApplyResult =
  | { ok: true; content: string; counts: number[] } // counts[i] = 第 i 条替换处数
  | { ok: false; index: number; kind: "not-found" | "ambiguous" | "same"; count?: number };

// 按序应用全部编辑到内存副本: 任一条 not-found/ambiguous/same → 不产出内容(调用方保证不落盘)
export function applyEdits(content: string, edits: EditItem[]): ApplyResult {
  let cur = content;
  const counts: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e.old_string) return { ok: false, index: i, kind: "same" }; // 空 old_string(execute 前置拦截, 防线)
    if (e.old_string === e.new_string) return { ok: false, index: i, kind: "same" };
    const count = cur.split(e.old_string).length - 1;
    if (count === 0) return { ok: false, index: i, kind: "not-found" };
    if (count > 1 && !e.replace_all) return { ok: false, index: i, kind: "ambiguous", count };
    cur = e.replace_all ? cur.split(e.old_string).join(e.new_string) : cur.replace(e.old_string, e.new_string);
    counts.push(count);
  }
  return { ok: true, content: cur, counts };
}

export class EditTool implements Tool {
  readonly name = "Edit";
  readonly description =
    "对文件做精确字符串替换(逐字符匹配, 含缩进)。必须先用 Read 读取目标文件。两种用法二选一: " +
    "单编辑(old_string/new_string/replace_all?)或多编辑 edits:[{old_string,new_string,replace_all?}](按序应用, 任一条失败则整体不落盘)";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: { type: "string", description: "单编辑模式: 要替换的原文(须在文件中唯一, 除非 replace_all)" },
      new_string: { type: "string", description: "单编辑模式: 替换后的文本" },
      replace_all: { type: "boolean", description: "替换所有出现(默认 false; 多编辑模式可按条覆写)" },
      edits: {
        type: "array",
        description: "多编辑模式(与 old_string/new_string 二选一): 按序应用的编辑列表, 原子落盘",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "要替换的原文" },
            new_string: { type: "string", description: "替换后的文本" },
            replace_all: { type: "boolean", description: "该条替换所有出现(默认 false)" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path"],
  };

  checkPermissions() {
    // 写操作 → 无静态意见, 交给瀑布后续层(allow 规则 / 分类器 / 用户)
    return { decision: null };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    // 文件级互斥: 读-新鲜度校验-写 必须原子(并行工具调用下防同文件写-写竞态)
    return withFileLock(path.resolve(String(input.path ?? "")), () => this.run(input));
  }

  // 输入 → 编辑列表(单/多两模式归一); 返回 string = 错误文案
  private normalizeEdits(input: Record<string, unknown>): EditItem[] | string {
    const hasEdits = input.edits !== undefined && input.edits !== null;
    const hasSingle = input.old_string !== undefined || input.new_string !== undefined;
    if (hasEdits && hasSingle) {
      return "参数错误: edits(多编辑)与 old_string/new_string(单编辑)二选一, 不可混用";
    }
    if (hasEdits) {
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        return "参数错误: edits 须为非空数组, 示例: [{\"old_string\": \"…\", \"new_string\": \"…\"}]";
      }
      const list: EditItem[] = [];
      for (let i = 0; i < input.edits.length; i++) {
        const it = input.edits[i];
        if (typeof it !== "object" || it === null) return `参数错误: edits[${i}] 必须为对象`;
        const rec = it as Record<string, unknown>;
        if (typeof rec.old_string !== "string" || typeof rec.new_string !== "string") {
          return `参数错误: edits[${i}] 需要 old_string / new_string(均为 string; new_string 显式空串 = 删除语义)`;
        }
        if (!rec.old_string) return `参数错误: edits[${i}].old_string 不能为空(需非空匹配串)`;
        if (rec.old_string === rec.new_string) return `参数错误: edits[${i}].old_string 与 new_string 相同, 无需编辑`;
        if (rec.replace_all !== undefined && typeof rec.replace_all !== "boolean") {
          return `参数错误: edits[${i}].replace_all 须为 boolean`;
        }
        list.push({ old_string: rec.old_string, new_string: rec.new_string, replace_all: rec.replace_all === true });
      }
      return list;
    }
    // 单编辑(直调防线: old_string/new_string 必须 string — new_string 缺失曾被 String() 转空串静默删除;
    // 显式 new_string: "" 仍合法 = 删除语义)
    if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
      return "参数错误: 需要 path / old_string / new_string";
    }
    if (!input.old_string) return "参数错误: old_string 不能为空(需非空匹配串)";
    if (input.old_string === input.new_string) return "old_string 与 new_string 相同, 无需编辑";
    if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") {
      return "参数错误: replace_all 须为 boolean";
    }
    return [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all === true }];
  }

  private async run(input: Record<string, unknown>): Promise<ToolResult> {
    const p = String(input.path ?? "");
    if (!p) return { content: "参数错误: 需要 path / old_string / new_string", isError: true };
    const edits = this.normalizeEdits(input);
    if (typeof edits === "string") return { content: edits, isError: true };
    const multi = input.edits !== undefined && input.edits !== null;

    let content: string;
    try {
      content = fs.readFileSync(p, "utf8");
    } catch (e) {
      return { content: `读取失败: ${(e as Error).message}`, isError: true };
    }

    // 先读后改 + 新鲜度校验
    const fresh = checkFreshness(p);
    if (fresh === "unread") {
      return {
        content: `File has not been read yet: ${p}\n请先用 Read 工具读取该文件, 再进行 Edit。`,
        isError: true,
      };
    }
    if (fresh === "stale") {
      return {
        content: `File has been modified since read: ${p}\n文件在 Read 之后被外部修改(新鲜度校验失败), 请重新 Read 后再 Edit。`,
        isError: true,
      };
    }

    const r = applyEdits(content, edits);
    if (!r.ok) {
      // 单编辑保持既有文案(既有测试依赖); 多编辑带序号定位失败条
      if (r.kind === "not-found") {
        return {
          content: multi
            ? `edits[${r.index}] old_string 未在 ${p} 中找到(必须逐字符精确匹配, 含缩进与空白; 此前 ${r.index} 条已匹配, 原子性保证整体未落盘)。文件开头 300 字符:\n` +
              content.slice(0, 300)
            : `old_string 未在 ${p} 中找到(必须逐字符精确匹配, 含缩进与空白)。文件开头 300 字符:\n` +
              content.slice(0, 300),
          isError: true,
        };
      }
      if (r.kind === "ambiguous") {
        return {
          content: multi
            ? `edits[${r.index}] old_string 在 ${p} 中出现 ${r.count} 次。请提供更长且唯一的匹配串(含上下文), 或设置 replace_all: true。`
            : `old_string 在 ${p} 中出现 ${r.count} 次。请提供更长且唯一的匹配串(含上下文), 或设置 replace_all: true。`,
          isError: true,
        };
      }
      return { content: `old_string 与 new_string 相同, 无需编辑`, isError: true };
    }

    fs.writeFileSync(p, r.content, "utf8");
    markWritten(p);

    // 结果摘要: 多编辑逐条计数 + 末条预览; 单编辑保持既有文案
    const total = r.counts.reduce((a, b) => a + b, 0);
    if (multi) {
      const last = edits[edits.length - 1];
      const idx = r.content.indexOf(last.new_string);
      return {
        content:
          `已编辑 ${p}: ${edits.length} 条编辑共替换 ${total} 处(${r.counts.map((c, i) => `#${i}×${c}`).join(", ")})。最后一条替换区域预览:\n` +
          r.content.slice(Math.max(0, idx - 60), idx + last.new_string.length + 60),
      };
    }
    const idx = r.content.indexOf(edits[0].new_string);
    return {
      content:
        `已编辑 ${p}: 替换 ${total} 处。替换区域预览:\n` +
        r.content.slice(Math.max(0, idx - 60), idx + edits[0].new_string.length + 60),
    };
  }
}
