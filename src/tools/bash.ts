// 架构参考: Bash 工具 — 真实 shell 执行 + 超时 + 输出上限 + 静态验证器
import { spawn } from "child_process";
import { ToolResult } from "../types";
import { Tool, ToolContext } from "./tool";
import { checkBashCommand } from "../permissions/staticChecks";

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 200_000; // 硬上限(T0 预算层之前先兜底)

export class BashTool implements Tool {
  readonly name = "Bash";
  readonly description = "执行 bash 命令并返回输出";
  readonly inputSchema = {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      timeout: { type: "number", description: "超时毫秒数" },
    },
    required: ["command"],
  };

  checkPermissions(input: Record<string, unknown>) {
    return checkBashCommand(String(input.command ?? ""));
  }

  async execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const command = String(input.command ?? "");
    const timeout = Number(input.timeout ?? EXEC_TIMEOUT_MS);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // 独立进程组: kill 整组防孙进程(如 sleep)持住 stdio 管道拖延 close
      });
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
      // 整组 SIGKILL(bash + 其子孙进程); 进程组已不存在时回退单进程 kill
      const killGroup = () => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, "SIGKILL"); // 负 pid = 整个进程组
        } catch {
          child.kill("SIGKILL"); // 进程组已不存在(如已退出) → 回退单进程 kill
        }
      };
      const timer = setTimeout(killGroup, timeout);
      // 用户中断: kill 整组(中断不是工具错误, 由主循环统一收尾)
      const onAbort = killGroup;
      const signal = ctx?.signal;
      if (signal) {
        if (signal.aborted) killGroup();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ content: `bash 执行失败: ${err.message}`, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          resolve({ content: (out ? out + "\n" : "") + "[aborted by user]", isError: true });
          return;
        }
        const content = truncated ? out + "\n[output truncated at 200K chars]" : out;
        resolve({ content, isError: code !== 0 });
      });
    });
  }
}
