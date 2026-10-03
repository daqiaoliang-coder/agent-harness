// 架构参考: git 一等公民 — 只读子命令白名单静态放行(免弹窗), 写操作走 Bash;
// argv 数组 spawn(不经 shell) → 无注入面; 超时/中断/输出上限沿用 Bash 风格
import { spawn } from "child_process";
import { ToolResult } from "../types";
import { Tool, ToolContext } from "./tool";
import { StaticCheckResult } from "../permissions/staticChecks";

// 只读子命令白名单: status/diff/log/show 免确认; 其余(commit/push/checkout/…)有副作用 → Bash 走权限瀑布
const READONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show"]);
const EXEC_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 100_000;

export class GitTool implements Tool {
  readonly name = "Git";
  readonly description = "查询 git 仓库状态(只读子命令 status/diff/log/show 免确认; 写操作请用 Bash)";
  readonly inputSchema = {
    type: "object",
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: "git 参数数组(如 [\"log\", \"--oneline\", \"-5\"]); 首参须为只读子命令",
      },
      path: { type: "string", description: "仓库目录(默认当前目录)" },
    },
    required: ["args"],
  };

  checkPermissions(input: Record<string, unknown>): StaticCheckResult {
    const args = input.args;
    if (!Array.isArray(args) || args.length === 0) return { decision: null };
    const sub = String(args[0]);
    if (READONLY_SUBCOMMANDS.has(sub)) {
      return { decision: "allow", reason: `git ${sub} 为只读操作` };
    }
    return {
      decision: "deny",
      reason: `git ${sub} 有副作用, Git 工具仅放行只读子命令(${[...READONLY_SUBCOMMANDS].join("/")}); 写操作请用 Bash`,
    };
  }

  async execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const args = input.args;
    if (!Array.isArray(args) || args.length === 0) {
      return { content: "参数错误: args 不能为空", isError: true };
    }
    // 二次校验(直调路径可能绕过权限瀑布): 非白名单首参直接报错引导
    const sub = String(args[0]);
    if (!READONLY_SUBCOMMANDS.has(sub)) {
      return {
        content: `git ${sub} 有副作用, 不在只读白名单(${[...READONLY_SUBCOMMANDS].join("/")})内; 写操作请用 Bash`,
        isError: true,
      };
    }
    const argv = args.map(String);
    const cwd = typeof input.path === "string" && input.path ? input.path : process.cwd();

    return new Promise<ToolResult>((resolve) => {
      // argv 数组直达 execve, 不经 shell → 参数注入面不存在
      const child = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let truncated = false;
      child.stdout.on("data", (d: Buffer) => {
        if (out.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
        out += d.toString();
        if (out.length > MAX_OUTPUT_CHARS) {
          out = out.slice(0, MAX_OUTPUT_CHARS);
          truncated = true;
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        if (out.length < MAX_OUTPUT_CHARS) out += d.toString();
      });
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } };
      const timer = setTimeout(kill, EXEC_TIMEOUT_MS);
      const onAbort = kill;
      const signal = ctx?.signal;
      if (signal) {
        if (signal.aborted) kill();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ content: `git 执行失败: ${err.message}`, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          resolve({ content: (out ? out + "\n" : "") + "[aborted by user]", isError: true });
          return;
        }
        const content = truncated ? out + `\n[output truncated at ${MAX_OUTPUT_CHARS / 1000}K chars]` : out;
        resolve({ content, isError: code !== 0 });
      });
    });
  }
}
