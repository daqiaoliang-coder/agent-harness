// 架构参考:的 Hook runner — spawn 子进程, stdin 喂 JSON payload
// 决策双协议:
//   ① 退出码 2 = 刻意拒绝(避开退出码 1 的"崩溃误报"歧义)
//   ② stdout 输出 JSON {hookSpecificOutput:{permissionDecision:"allow"|"deny"|"ask", ...}}
//   退出码 0 且无 JSON = 放行(stdout 作为非阻断反馈)
//   其他非零退出码 = 非阻断错误(警告后继续, 崩溃 ≠ 拦截)
// 同事件多 hook 严格顺序执行; 聚合规则: deny > ask > allow
import { spawn } from "child_process";
import { HookConfig, HookDecision, HookEventName, HookPayload, HookSettings } from "./events";

export interface HookSessionInfo {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
}

export class HookRunner {
  constructor(
    private settings: HookSettings,
    private projectRoot: string,
    private log: (line: string) => void
  ) {}

  // 设置热加载: settings.json 变更时替换 Hook 配置(参考原版架构设置实时生效)
  updateSettings(settings: HookSettings): void {
    this.settings = settings;
  }

  async run(
    event: HookEventName,
    ctx: { toolName?: string; toolInput?: unknown },
    session: HookSessionInfo
  ): Promise<HookDecision> {
    const configs = this.settings[event] ?? [];
    const matched = configs.filter((c) => this.matcherMatches(c.matcher, ctx.toolName));

    let decision: "allow" | "deny" | "ask" | null = null;
    let feedback: string | undefined;

    for (const cfg of matched) {
      // 同事件多 hook 严格顺序执行(不并发)
      for (const hook of cfg.hooks) {
        const result = await this.runOne(hook, event, ctx, session);
        if (result.decision === "deny") decision = "deny";
        else if (result.decision === "ask" && decision !== "deny") decision = "ask";
        else if (result.decision === "allow" && decision === null) decision = "allow";
        if (result.feedback) feedback = result.feedback;
      }
    }
    return { decision, feedback, matched: matched.length };
  }

  private matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
    if (!matcher) return true;
    if (!toolName) return false;
    if (matcher === toolName) return true;
    try {
      return new RegExp(matcher).test(toolName);
    } catch {
      return false;
    }
  }

  private runOne(
    hook: { command: string; timeout?: number },
    event: HookEventName,
    ctx: { toolName?: string; toolInput?: unknown },
    session: HookSessionInfo
  ): Promise<{ decision: "allow" | "deny" | "ask" | null; feedback?: string }> {
    const payload: HookPayload = {
      session_id: session.sessionId,
      transcript_path: session.transcriptPath,
      cwd: session.cwd,
      hook_event_name: event,
      tool_name: ctx.toolName,
      tool_input: ctx.toolInput,
    };

    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", hook.command], {
        cwd: this.projectRoot, // hook 命令中的相对路径以项目根为基准
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let settled = false;
      const finish = (r: { decision: "allow" | "deny" | "ask" | null; feedback?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        this.log(`[hook] ${event}/${ctx.toolName ?? "-"} 超时被杀(视为非阻断错误)`);
        finish({ decision: null });
      }, hook.timeout ?? 10_000);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stdout += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timeout);
        this.log(`[hook] ${event} 启动失败: ${err.message}`);
        finish({ decision: null });
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        // 协议①: 退出码 2 = 刻意拒绝
        if (code === 2) {
          this.log(`[hook] ${event}/${ctx.toolName ?? "-"} → DENY (exit 2, 刻意拒绝): ${stdout.trim().slice(0, 120)}`);
          finish({ decision: "deny", feedback: stdout.trim() });
          return;
        }
        // 协议②: stdout JSON 决策
        const jsonDecision = this.parseStdoutDecision(stdout);
        if (jsonDecision) {
          this.log(
            `[hook] ${event}/${ctx.toolName ?? "-"} → ${jsonDecision.permissionDecision.toUpperCase()} ` +
              `(JSON 协议): ${jsonDecision.permissionDecisionReason ?? ""}`.slice(0, 200)
          );
          finish({
            decision: jsonDecision.permissionDecision,
            feedback: jsonDecision.permissionDecisionReason,
          });
          return;
        }
        if (code !== 0) {
          // 非零非 2: 崩溃 ≠ 拦截, 警告后放行
          this.log(`[hook] ${event}/${ctx.toolName ?? "-"} 非预期退出码 ${code}(视为放行, 崩溃不等于拦截)`);
          finish({ decision: null, feedback: stdout.trim() || undefined });
          return;
        }
        // 退出码 0 无 JSON: 放行, stdout 作为反馈
        finish({ decision: null, feedback: stdout.trim() || undefined });
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  private parseStdoutDecision(
    stdout: string
  ): { permissionDecision: "allow" | "deny" | "ask"; permissionDecisionReason?: string } | null {
    const jsonStart = stdout.indexOf("{");
    const jsonEnd = stdout.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd <= jsonStart) return null;
    try {
      const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as {
        hookSpecificOutput?: {
          hookEventName?: string;
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      const d = parsed.hookSpecificOutput?.permissionDecision;
      if (d === "allow" || d === "deny" || d === "ask") {
        return {
          permissionDecision: d,
          permissionDecisionReason: parsed.hookSpecificOutput?.permissionDecisionReason,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
