// 架构参考: Read 工具 — 只读, 静态检查直接放行; 读取后记录快照供 Edit 新鲜度校验
import * as fs from "fs";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { markRead } from "./fileState";

const MAX_READ_CHARS = 100_000;

export class ReadTool implements Tool {
  readonly name = "Read";
  readonly description = "读取文件内容";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
  };

  checkPermissions() {
    // 只读工具 → 瀑布第②层直接放行
    return { decision: "allow" as const, reason: "Read 为只读工具" };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const p = String(input.path ?? "");
    try {
      const content = fs.readFileSync(p, "utf8");
      markRead(p); // 记录快照(mtime+size), 供 Edit 做先读后改/新鲜度校验
      return {
        content: content.length > MAX_READ_CHARS ? content.slice(0, MAX_READ_CHARS) + "\n[truncated]" : content,
      };
    } catch (e) {
      return { content: `读取失败: ${(e as Error).message}`, isError: true };
    }
  }
}
