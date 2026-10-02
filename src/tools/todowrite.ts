// 架构参考: TodoWrite 工具 — 任务清单全量替换(每次传完整清单, 非增量 patch);
// 单一 in_progress 为提示层纪律(harness 不强制), 状态由本实例持有(每会话独立实例 → 天然隔离)
import { Message, ToolResult } from "../types";
import { TodoItem } from "../events";
import { Tool, ToolContext } from "./tool";

export interface TodoWriteDeps {
  // 状态变更外发(桥接 UiEvent "todos"; 不传则纯内部状态)
  emit?: (todos: TodoItem[]) => void;
  log?: (line: string) => void;
}

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

// 共享校验(execute 与 restoreFrom 复用): 一次收集全部 issues(详细错误一次给全)
type Normalized = { ok: true; todos: TodoItem[] } | { ok: false; issues: string[] };

function normalize(input: Record<string, unknown>): Normalized {
  const raw = input.todos;
  if (!Array.isArray(raw)) {
    return { ok: false, issues: ["todos: 必须为数组, 且为完整清单(全量替换语义), 示例: [{\"content\": \"…\", \"status\": \"pending\"}]"] };
  }
  const issues: string[] = [];
  const todos: TodoItem[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      issues.push(`todos[${i}]: 必须为对象`);
      return;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.content !== "string" || rec.content.trim() === "") {
      issues.push(`todos[${i}].content: 必须为非空字符串`);
    }
    if (typeof rec.status !== "string" || !VALID_STATUSES.has(rec.status)) {
      issues.push(`todos[${i}].status: 非法值 ${JSON.stringify(rec.status) ?? rec.status}, 合法枚举: pending | in_progress | completed`);
    }
    if (rec.activeForm !== undefined && typeof rec.activeForm !== "string") {
      issues.push(`todos[${i}].activeForm: 可选字段, 传入则必须为字符串`);
    }
    if (typeof rec.content === "string" && typeof rec.status === "string" && VALID_STATUSES.has(rec.status)) {
      const t: TodoItem = { content: rec.content, status: rec.status as TodoItem["status"] };
      if (typeof rec.activeForm === "string" && rec.activeForm.trim() !== "") t.activeForm = rec.activeForm;
      todos.push(t);
    }
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, todos };
}

export class TodoWriteTool implements Tool {
  readonly name = "TodoWrite";
  readonly description = [
    "更新任务清单(全量替换: 每次传入完整清单, 未包含的项即被移除)。",
    "多步任务(≥3 步)开工前先建清单; 恰好保持一项 in_progress; 步骤状态变化时立即更新; 全部完成后逐项标记 completed。",
    "status 枚举: pending | in_progress | completed; activeForm 为进行中该步骤的现在时描述(可选)。",
  ].join(" ");
  readonly inputSchema = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "步骤描述(祈使句, 如 \"重命名 server.ts\")" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "步骤状态" },
            activeForm: { type: "string", description: "进行中描述(可选, 如 \"正在重命名 server.ts\")" },
          },
          required: ["content", "status"],
        },
        description: "完整任务清单(全量替换当前清单; 空数组 = 清空)",
      },
    },
    required: ["todos"],
  };

  private todos: TodoItem[] = [];

  constructor(private deps: TodoWriteDeps = {}) {}

  // 纯内部状态工具: 静态 allow 免弹窗(plan 模式亦放行); PreToolUse Hook 仍可拦截
  checkPermissions() {
    return { decision: "allow" as const, reason: "TodoWrite 为内部任务状态更新, 无外部副作用" };
  }

  async execute(input: Record<string, unknown>, _ctx?: ToolContext): Promise<ToolResult> {
    const r = normalize(input);
    if (!r.ok) {
      return {
        content:
          "TodoWrite 输入校验失败:\n" +
          r.issues.map((s) => `  - ${s}`).join("\n") +
          "\n签名: TodoWrite(todos: [{content, status, activeForm?}]) — todos 必须为完整清单(全量替换)",
        isError: true,
      };
    }
    this.todos = r.todos; // 全量替换语义
    this.deps.emit?.(this.getTodos());
    const summary = this.summary();
    this.deps.log?.(`[todos] ${summary}`);
    return { content: `任务清单已更新: ${summary}` };
  }

  // resume: 逆向扫消息树取最后一次校验通过的 TodoWrite tool_use 重建状态
  // (无效写入在 execute 即失败不落状态 → 最后 normalize-clean 的 tool_use = 最后成功状态)
  restoreFrom(messages: Message[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const blocks = [...messages[i].content].reverse(); // 块内亦取最后
      for (const b of blocks) {
        if (b.type !== "tool_use" || b.name !== this.name) continue;
        const r = normalize(b.input);
        if (r.ok) {
          this.todos = r.todos;
          return true;
        }
      }
    }
    return false;
  }

  // 浅拷贝防引用外泄(外部改返回值不影响内部状态)
  getTodos(): TodoItem[] {
    return this.todos.map((t) => ({ ...t }));
  }

  // /status 与 web 徽章摘要行: 总数 + 分状态计数
  summary(): string {
    if (this.todos.length === 0) return "任务清单: 无(未建清单或已清空)";
    const c = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of this.todos) c[t.status]++;
    return `任务清单 ${this.todos.length} 项: ${c.completed} completed / ${c.in_progress} in_progress / ${c.pending} pending`;
  }
}
