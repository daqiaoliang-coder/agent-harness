// 架构参考: Edit 工具 — 精确字符串替换(逐字符匹配, 含缩进)
// + 先读后改(必须先 Read) + 编辑新鲜度校验(Read 后被外部修改则拒绝)
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { checkFreshness, markWritten, withFileLock } from "./fileState";

export class EditTool implements Tool {
  readonly name = "Edit";
  readonly description = "对文件做精确字符串替换。必须先用 Read 读取目标文件; old_string 必须逐字符精确匹配(含缩进与空白)";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: { type: "string", description: "要替换的原文(须在文件中唯一, 除非 replace_all)" },
      new_string: { type: "string", description: "替换后的文本" },
      replace_all: { type: "boolean", description: "替换所有出现(默认 false)" },
    },
    required: ["path", "old_string", "new_string"],
  };

  checkPermissions() {
    // 写操作 → 无静态意见, 交给瀑布后续层(allow 规则 / 分类器 / 用户)
    return { decision: null };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    // 文件级互斥: 读-新鲜度校验-写 必须原子(并行工具调用下防同文件写-写竞态)
    return withFileLock(path.resolve(String(input.path ?? "")), () => this.run(input));
  }

  private async run(input: Record<string, unknown>): Promise<ToolResult> {
    const p = String(input.path ?? "");
    // 直调防线: old_string/new_string 必须为 string — new_string 缺失曾被 String() 转空串,
    // old_string 非空时静默删除匹配内容; 显式 new_string: "" 仍合法(删除语义)
    if (!p || typeof input.old_string !== "string" || typeof input.new_string !== "string") {
      return { content: "参数错误: 需要 path / old_string / new_string", isError: true };
    }
    const oldStr = input.old_string;
    const newStr = input.new_string;
    const replaceAll = input.replace_all === true;

    if (!oldStr) {
      return { content: "参数错误: old_string 不能为空(需非空匹配串)", isError: true };
    }
    if (oldStr === newStr) {
      return { content: "old_string 与 new_string 相同, 无需编辑", isError: true };
    }

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

    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return {
        content:
          `old_string 未在 ${p} 中找到(必须逐字符精确匹配, 含缩进与空白)。文件开头 300 字符:\n` +
          content.slice(0, 300),
        isError: true,
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        content: `old_string 在 ${p} 中出现 ${count} 次。请提供更长且唯一的匹配串(含上下文), 或设置 replace_all: true。`,
        isError: true,
      };
    }

    const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    fs.writeFileSync(p, updated, "utf8");
    markWritten(p);

    const idx = updated.indexOf(newStr);
    return {
      content:
        `已编辑 ${p}: 替换 ${count} 处。替换区域预览:\n` +
        updated.slice(Math.max(0, idx - 60), idx + newStr.length + 60),
    };
  }
}
