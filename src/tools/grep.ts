// 架构参考: Grep 工具(ripgrep 包装, path:line:content 格式, head_limit 截断)
// 零依赖实现: 递归遍历 + 逐行正则匹配; 跳过二进制与大文件
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { walkFiles, globToRegex } from "./walk";

const DEFAULT_MAX_RESULTS = 50;
const MAX_FILE_BYTES = 1024 * 1024; // 超过 1MB 的文件跳过

export class GrepTool implements Tool {
  readonly name = "Grep";
  readonly description = "在文件或目录中按正则逐行搜索, 输出 path:line:content; 可用 glob 参数过滤文件名";
  readonly inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "搜索的文件或目录(默认当前目录)" },
      glob: { type: "string", description: "文件名过滤 glob(如 *.ts)" },
      max_results: { type: "number", description: `最大命中条数(默认 ${DEFAULT_MAX_RESULTS})` },
    },
    required: ["pattern"],
  };

  checkPermissions() {
    // 只读工具 → 瀑布第②层直接放行
    return { decision: "allow" as const, reason: "Grep 为只读工具" };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input.pattern ?? "");
    const root = path.resolve(String(input.path ?? "."));
    if (!pattern) return { content: "参数错误: 需要 pattern", isError: true };
    if (!fs.existsSync(root)) return { content: `路径不存在: ${root}`, isError: true };

    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { content: `无效正则 ${JSON.stringify(pattern)}: ${(e as Error).message}`, isError: true };
    }
    const maxResults = Math.min(Number(input.max_results ?? DEFAULT_MAX_RESULTS) || DEFAULT_MAX_RESULTS, 500);
    const globRe = input.glob ? globToRegex(String(input.glob)) : null;

    // 目标: 单文件(相对路径=basename) 或 目录遍历(相对路径相对 root; 可按 glob 过滤)
    const isFile = fs.statSync(root).isFile();
    const relBase = isFile ? path.dirname(root) : root;
    const targets: string[] = isFile
      ? [root]
      : walkFiles(root).filter((abs) => !globRe || globRe.test(path.basename(abs)));

    const lines: string[] = [];
    let fileHits = 0;
    let totalMatches = 0;
    let truncated = false;
    for (const abs of targets) {
      if (truncated) break;
      let content: string;
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) continue; // 大文件跳过
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // 二进制跳过
      const rel = path.relative(relBase, abs).split(path.sep).join("/");
      const linesArr = content.split("\n");
      let hitInFile = false;
      for (let i = 0; i < linesArr.length; i++) {
        if (!re.test(linesArr[i])) continue;
        totalMatches++;
        hitInFile = true;
        if (lines.length < maxResults) lines.push(`${rel}:${i + 1}:${linesArr[i].slice(0, 200).trim()}`);
        else truncated = true;
      }
      if (hitInFile) fileHits++;
    }

    if (lines.length === 0) return { content: `未找到匹配 ${JSON.stringify(pattern)} 的行` };
    return {
      content:
        lines.join("\n") +
        `\n(命中 ${fileHits} 个文件 / ${totalMatches} 处${truncated ? `, 仅显示前 ${maxResults} 条` : ""})`,
    };
  }
}
