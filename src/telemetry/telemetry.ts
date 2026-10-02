// 错误遥测(本地优先, 无外部服务):
//   - 引擎级异常(provider/budget/compact/hook/engine 分类)→ 结构化 JSONL 落盘 + 内存计数
//   - 工具级失败(执行失败/未知工具)→ 仅计数(权限拒绝/用户中断为正常工作流, 不计)
//   - RunAbortedError(用户中断)一律不计 — 区分"中断"与"故障"
// 计数为进程生命周期语义; Web 模式经 GET /api/stats 外发, CLI chat 退出时打印摘要。
import * as fs from "fs";
import * as path from "path";
import { RunAbortedError } from "../types";

export type ErrorCategory = "provider" | "tool" | "hook" | "budget" | "compact" | "engine";

export interface ErrorStats {
  total: number;
  byCategory: Record<ErrorCategory, number>;
  toolErrors: number;
}

// 错误分类启发式(按序匹配; budget/compact 先于 provider, 避免消息中的数字误判):
//   budget: 预算熔断/轮次守卫  compact: 水位/autocompact 熔断
//   provider: HTTP/API/网络类   hook: Hook 相关   其余: engine
export function classifyError(e: unknown): ErrorCategory | null {
  if (e instanceof RunAbortedError) return null; // 用户中断不算故障
  const msg = e instanceof Error ? e.message : String(e);
  if (/预算熔断|最大轮次/.test(msg)) return "budget";
  if (/blocking 水位|autocompact 熔断/.test(msg)) return "compact";
  if (/HTTP|API|overloaded|rate.?limit|fetch|network|ECONN|timeout/i.test(msg)) return "provider";
  if (/hook/i.test(msg)) return "hook";
  return "engine";
}

export class Telemetry {
  /** 错误 JSONL 落盘路径(.agent-harness/telemetry/errors.jsonl) */
  readonly logFile: string;
  private readonly startedAt = new Date().toISOString();
  private total = 0;
  private toolErrs = 0;
  private readonly byCategory: Record<ErrorCategory, number> = {
    provider: 0, tool: 0, hook: 0, budget: 0, compact: 0, engine: 0,
  };
  private readonly perSession = new Map<string, number>();

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.logFile = path.join(dir, "errors.jsonl");
  }

  /** 引擎级异常记录: 分类 + JSONL 落盘; RunAbortedError 返回 null 不计入 */
  recordError(sessionId: string, e: unknown): ErrorCategory | null {
    const category = classifyError(e);
    if (category === null) return null;
    this.total++;
    this.byCategory[category]++;
    this.perSession.set(sessionId, (this.perSession.get(sessionId) ?? 0) + 1);
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    try {
      fs.appendFileSync(
        this.logFile,
        JSON.stringify({ ts: new Date().toISOString(), sessionId, category, message }) + "\n",
        "utf8"
      );
    } catch {
      // 落盘失败(只读目录等)不阻断主流程, 内存计数仍有效
    }
    return category;
  }

  /** 工具级失败计数(执行失败/未知工具; 结果以 error tool_result 入树, 不落 JSONL) */
  recordToolError(): void {
    this.toolErrs++;
  }

  sessionErrorCount(sessionId: string): number {
    return this.perSession.get(sessionId) ?? 0;
  }

  get errorStats(): ErrorStats {
    return { total: this.total, byCategory: { ...this.byCategory }, toolErrors: this.toolErrs };
  }

  get since(): string {
    return this.startedAt;
  }
}

// 进程级共享实例(cli.ts createSession 与 web /api/stats 必须读到同一份计数)
let shared: Telemetry | null = null;
export function getTelemetry(projectRoot: string): Telemetry {
  if (!shared) shared = new Telemetry(path.join(projectRoot, ".agent-harness", "telemetry"));
  return shared;
}
