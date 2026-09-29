// 架构参考: Glob 工具 — glob 模式匹配文件名, 结果按 mtime 倒序(最近修改优先)
// 零依赖实现: glob → 正则(*=单层, **=跨目录, ?=单字符); 不支持 {} 展开与字符类
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { walkFiles, globToRegex } from "./walk";

const MAX_RESULTS = 100;

export class GlobTool implements Tool {
  readonly name = "Glob";
  readonly description = "按 glob 模式查找文件(* 单层, ** 跨目录, ? 单字符), 结果按修改时间倒序。例: src/**/*.ts";
  readonly inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式(如 **/*.ts)" },
      path: { type: "string", description: "搜索根目录(默认当前目录)" },
    },
    required: ["pattern"],
  };

  checkPermissions() {
    // 只读工具 → 瀑布第②层直接放行
    return { decision: "allow" as const, reason: "Glob 为只读工具" };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input.pattern ?? "");
    const root = path.resolve(String(input.path ?? "."));
    if (!pattern) return { content: "参数错误: 需要 pattern", isError: true };
    if (!fs.existsSync(root)) return { content: `目录不存在: ${root}`, isError: true };

    const re = globToRegex(pattern);
    const files = walkFiles(root)
      .map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }))
      .filter((f) => re.test(f.rel))
      .sort((a, b) => fs.statSync(b.abs).mtimeMs - fs.statSync(a.abs).mtimeMs); // mtime 倒序

    if (files.length === 0) return { content: `未找到匹配 ${pattern} 的文件` };
    const shown = files.slice(0, MAX_RESULTS);
    return {
      content:
        shown.map((f) => f.rel).join("\n") +
        (files.length > MAX_RESULTS ? `\n…(共 ${files.length} 个, 显示前 ${MAX_RESULTS})` : `\n(共 ${files.length} 个文件)`),
    };
  }
}
