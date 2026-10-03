// 架构参考: Write 工具 — 写操作无静态放行, 必须走规则/用户瀑布; 成功后更新文件快照
import * as fs from "fs";
import * as path from "path";
import { ToolResult } from "../types";
import { Tool } from "./tool";
import { FileStateStore, defaultFileStateStore, withFileLock } from "./fileState";

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

  private readonly store: FileStateStore;

  // store 注入: 每会话独立快照(同 ReadTool; 缺省共享单例沿用旧语义)
  constructor(opts: { store?: FileStateStore } = {}) {
    this.store = opts.store ?? defaultFileStateStore();
  }

  checkPermissions() {
    // 写操作 → 无意见, 交给瀑布后续层(allow 规则 / 分类器 / 用户)
    return { decision: null };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const p = String(input.path ?? "");
    if (!p) return { content: "参数错误: path 不能为空", isError: true };
    // 直调防线: content 缺失/非 string → 拒绝。String(undefined) 转空串曾静默清空已存在文件;
    // 显式 content: "" 仍合法(= truncate 意图), "缺失"与"空"必须区分
    const content = input.content;
    if (typeof content !== "string") {
      return {
        content: `参数错误: content 必须为 string(收到 ${content === undefined ? "undefined" : typeof content})`,
        isError: true,
      };
    }
    // 文件级互斥: 与并行 Edit/Write 串行(防整写覆盖丢失编辑)
    return withFileLock(path.resolve(p), () => this.run(p, content));
  }

  private async run(p: string, content: string): Promise<ToolResult> {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      this.store.markWritten(p); // 更新快照, 允许 Write 后直接 Edit
      return { content: `已写入 ${p} (${content.length} chars)` };
    } catch (e) {
      return { content: `写入失败: ${(e as Error).message}`, isError: true };
    }
  }
}
