// 结构化 UI 事件总线 — 引擎(query.ts/engine.ts)与前端(CLI/Web)之间的解耦层。
// 参考原版架构: 其 UI 渲染内嵌在主循环; 这里改为类型化事件外发, CLI 与 Web 前端均作为订阅方。
import { Message } from "./types";
import { PermissionPreview } from "./permissions/preview";

// 任务清单条目(TodoWrite 工具维护, 全量替换语义)。
// 定义在此防 import 环: todowrite.ts → events.ts 单向依赖, events.ts 不可反向 import
export interface TodoItem {
  content: string; // 步骤描述(祈使句)
  status: "pending" | "in_progress" | "completed";
  activeForm?: string; // 进行中描述(如 "正在重命名文件"); 前端 in_progress 时优先展示
}

export type UiEvent =
  // 会话元信息(SSE 连接建立 / 新建 / resume 后广播)
  | { kind: "ready"; sessionId: string; model: string; mode: string; provider: string }
  // 历史回放(SSE 连接时把当前消息树重放给前端; 复用同一套事件词汇)
  | { kind: "history"; events: UiEvent[] }
  | { kind: "user_message"; text: string }
  // 流式文本增量(completeStream onTextDelta 桥接)
  | { kind: "assistant_delta"; text: string }
  // 完整助手文本(非流式 provider / mock; 含伴随工具调用的说明文字)
  | { kind: "assistant_message"; text: string }
  // 工具调用生命周期
  | { kind: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; name: string; output: string; isError: boolean }
  // 权限弹窗(Web userResponder 桥接: 请求 → 浏览器渲染 → HTTP 应答 → resolve)
  //   preview: Edit/Write diff 预览(无则前端回落 JSON); alwaysRule: 选"总是允许"将记住的会话规则
  | {
      kind: "permission_request";
      id: string;
      toolName: string;
      reason: string;
      input: Record<string, unknown>;
      preview?: PermissionPreview;
      alwaysRule?: string;
    }
  | { kind: "permission_resolved"; id: string; answer: "yes" | "no" | "always" }
  // 权限瀑布判决(遥测; UI 在工具卡片上标注来源)
  | { kind: "perm"; id: string; decision: string; source: string; reason: string }
  // Slash 命令输出("/" 开头被命令注册表拦截, 不发给 LLM; 前端渲染为系统行)
  | { kind: "command_output"; text: string }
  // 运行中权限模式切换(/mode 或 Web 徽章下拉; 前端同步徽章, 多标签页一致)
  | { kind: "mode_changed"; mode: string }
  // 用量遥测(每主循环轮一推, 轮入口快照): 上下文水位 + 会话累计 → 前端渲染 topbar 水位条
  | {
      kind: "usage";
      turn: number;
      bufferTokens: number;
      totalTokensUsed: number;
      tokenBudget?: number;
      watermarks: { effectiveWindow: number; autoCompactAt: number; warningAt: number; blockingAt: number };
    }
  // 压缩管线触发(T0-T5)
  | { kind: "compact"; level: string; detail: string }
  // 任务清单快照(TodoWrite 每次全量替换后外发; 前端渲染清单面板)
  | { kind: "todos"; todos: TodoItem[] }
  // 引擎日志行(水位/usage/cache 等; 前端默认折叠)
  | { kind: "log"; text: string }
  | { kind: "error"; text: string }
  // 用户中断(Ctrl-C / Web 停止): 本轮提前收尾(消息树已保证一致)
  | { kind: "aborted" }
  // 本轮 Stop(主循环跑到无工具调用; 前端关闭流式气泡)
  | { kind: "stop" };

// 最后一次 TodoWrite 快照提取(逆向扫消息树)。
// 轻量内联校验, 不 import todowrite.ts 防环; 非法写入在 execute 即失败不落状态,
// 故最后校验通过的 tool_use 即最后成功清单(与 TodoWriteTool.restoreFrom 同一约定)
function lastTodosSnapshot(messages: Message[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = [...messages[i].content].reverse();
    for (const b of blocks) {
      if (b.type !== "tool_use" || b.name !== "TodoWrite") continue;
      const raw = (b.input as { todos?: unknown })?.todos;
      if (!Array.isArray(raw)) continue;
      const todos: TodoItem[] = [];
      let valid = true;
      for (const item of raw) {
        if (typeof item !== "object" || item === null) {
          valid = false;
          break;
        }
        const rec = item as Record<string, unknown>;
        if (
          typeof rec.content !== "string" ||
          rec.content.trim() === "" ||
          typeof rec.status !== "string" ||
          !["pending", "in_progress", "completed"].includes(rec.status)
        ) {
          valid = false;
          break;
        }
        const t: TodoItem = { content: rec.content, status: rec.status as TodoItem["status"] };
        if (typeof rec.activeForm === "string" && rec.activeForm.trim() !== "") t.activeForm = rec.activeForm;
        todos.push(t);
      }
      if (valid) return todos;
    }
  }
  return null;
}

// 历史回放: 消息树 → 事件序列(tool_use/tool_result 按 id 配对还原卡片)
export function historyFromMessages(messages: Message[]): UiEvent[] {
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") toolNames.set(b.id, b.name);
    }
  }
  const events: UiEvent[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") {
        events.push(m.role === "user" ? { kind: "user_message", text: b.text } : { kind: "assistant_message", text: b.text });
      } else if (b.type === "tool_use") {
        events.push({ kind: "tool_start", id: b.id, name: b.name, input: b.input });
      } else if (b.type === "tool_result") {
        events.push({
          kind: "tool_result",
          id: b.tool_use_id,
          name: toolNames.get(b.tool_use_id) ?? "unknown",
          output: b.content,
          isError: b.is_error === true,
        });
      }
    }
  }
  // 末尾追加快照事件: resume 回放时前端清单面板与消息树状态对齐(最后成功清单)
  const snapshot = lastTodosSnapshot(messages);
  if (snapshot) events.push({ kind: "todos", todos: snapshot });
  return events;
}

export class EventBus {
  private listeners = new Set<(e: UiEvent) => void>();
  // 最近事件环形缓冲(SSE 重连/新连接时前端可选择补放; 简化: 只在连接时重放 history, 不缓冲)
  on(fn: (e: UiEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: UiEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // 单个订阅者异常不阻断其他订阅者
      }
    }
  }
}
