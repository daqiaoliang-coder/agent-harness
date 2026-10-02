// 架构参考: Write 工具 — 写操作无静态放行, 必须走规则/用户瀑布; 成功后更新文件快照
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { markWritten, withFileLock } from "./fileState";

export class WriteTool implements Tool {
  readonly name = "Write";
  readonly description = "写入文件";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "文件内容" },
    },
    required: ["path", "content"],
  };

  checkPermissions() {
    // 写操作 → 无意见, 交给瀑布后续层(allow 规则 / 分类器 / 用户)
    return { decision: null };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    // 文件级互斥: 与并行 Edit/Write 串行(防整写覆盖丢失编辑)
    return withFileLock(path.resolve(String(input.path ?? "")), () => this.run(input));
  }

  private async run(input: Record<string, unknown>): Promise<ToolResult> {
    const p = String(input.path ?? "");
    const content = String(input.content ?? "");
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      markWritten(p); // 更新快照, 允许 Write 后直接 Edit
      return { content: `已写入 ${p} (${content.length} chars)` };
    } catch (e) {
      return { content: `写入失败: ${(e as Error).message}`, isError: true };
    }
  }
}
