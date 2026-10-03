// 架构参考: Read 工具 — 只读, 静态检查直接放行; 读取后记录快照供 Edit 新鲜度校验
import * as fs from "fs";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { FileStateStore, defaultFileStateStore } from "./fileState";

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

  private readonly store: FileStateStore;

  // store 注入: 每会话独立快照(Web 多会话防跨会话泄漏 + resume 持久化); 缺省共享单例(直调/测试沿用旧语义)
  constructor(opts: { store?: FileStateStore } = {}) {
    this.store = opts.store ?? defaultFileStateStore();
  }

  checkPermissions() {
    // 只读工具 → 瀑布第②层直接放行
    return { decision: "allow" as const, reason: "Read 为只读工具" };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const p = String(input.path ?? "");
    if (!p) return { content: "参数错误: path 不能为空", isError: true };
    try {
      const content = fs.readFileSync(p, "utf8");
      this.store.markRead(p); // 记录快照(mtime+size), 供 Edit 做先读后改/新鲜度校验
      return {
        content: content.length > MAX_READ_CHARS ? content.slice(0, MAX_READ_CHARS) + "\n[truncated]" : content,
      };
    } catch (e) {
      return { content: `读取失败: ${(e as Error).message}`, isError: true };
    }
  }
}
