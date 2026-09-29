// 架构参考: Bash 工具 — 真实 shell 执行 + 超时 + 输出上限 + 静态验证器
import { spawn } from "child_process";
import { ToolResult } from "../types";
import { Tool } from "./tool";
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

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input.command ?? "");
    const timeout = Number(input.timeout ?? EXEC_TIMEOUT_MS);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
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
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ content: `bash 执行失败: ${err.message}`, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const content = truncated ? out + "\n[output truncated at 200K chars]" : out;
        resolve({ content, isError: code !== 0 });
      });
    });
  }
}
