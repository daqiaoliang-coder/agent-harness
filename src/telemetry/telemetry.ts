// 错误遥测(本地优先, 无外部服务):
//   - 引擎级异常(provider/budget/compact/hook/engine 分类)→ 结构化 JSONL 落盘 + 内存计数
//   - 工具级失败(执行失败/未知工具)→ 仅计数(权限拒绝/用户中断为正常工作流, 不计)
//   - RunAbortedError(用户中断)一律不计 — 区分"中断"与"故障"
// 用量遥测: 每次 LLM 主调用(计费全口径)记录 {ts, sessionId, in, out, cache 读写} →
//   usage.jsonl 落盘 + 内存聚合(滚动 5h 窗口, Web /api/usage 与 /usage 命令共用)。
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

// 单次 LLM 调用量量记录(与 Anthropic usage 字段一一对应; ts 可注入供测试窗口边界)
export interface UsageRecord {
  ts: string;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface UsageWindowStats {
  since: string; // 窗口内最早记录 ts(无记录 → 进程启动时间)
  windowMs: number;
  calls: number;
  sessions: number;
  totals: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number };
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
  /** 用量 JSONL 落盘路径(.agent-harness/telemetry/usage.jsonl) */
  readonly usageLogFile: string;
  private readonly startedAt = new Date().toISOString();
  private total = 0;
  private toolErrs = 0;
  private readonly byCategory: Record<ErrorCategory, number> = {
    provider: 0, tool: 0, hook: 0, budget: 0, compact: 0, engine: 0,
  };
  private readonly perSession = new Map<string, number>();
  // 用量内存态(滚动窗口聚合源; ts 可注入 → 过滤按 ts 计算, 不依赖调用时刻)
  private readonly usage: UsageRecord[] = [];

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.logFile = path.join(dir, "errors.jsonl");
    this.usageLogFile = path.join(dir, "usage.jsonl");
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

  /** 用量记录: 一次 LLM 主调用(计费全口径)→ 内存 + usage.jsonl; ts 可注入(测试窗口边界) */
  recordUsage(
    sessionId: string,
    u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
    ts: string = new Date().toISOString()
  ): void {
    const rec: UsageRecord = {
      ts,
      sessionId,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
    };
    this.usage.push(rec);
    try {
      fs.appendFileSync(this.usageLogFile, JSON.stringify(rec) + "\n", "utf8");
    } catch {
      // 落盘失败(只读目录等)不阻断主流程, 内存聚合仍有效
    }
  }

  /** 滚动窗口聚合(默认 5h): 窗口内全部调用的 totals/calls/sessions */
  usageStats(windowMs: number = 5 * 60 * 60 * 1000): UsageWindowStats {
    const cutoff = Date.now() - windowMs;
    const inWindow = this.usage.filter((r) => Date.parse(r.ts) >= cutoff);
    const t = inWindow.reduce(
      (a, r) => ({
        input: a.input + r.input,
        output: a.output + r.output,
        cacheRead: a.cacheRead + r.cacheRead,
        cacheCreate: a.cacheCreate + r.cacheCreate,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    );
    return {
      since: inWindow.length > 0 ? inWindow[0].ts : this.startedAt,
      windowMs,
      calls: inWindow.length,
      sessions: new Set(inWindow.map((r) => r.sessionId)).size,
      totals: { ...t, total: t.input + t.output + t.cacheRead + t.cacheCreate },
    };
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
