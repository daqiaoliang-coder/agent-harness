// 架构参考: MCP 层 — stdio transport + JSON-RPC 2.0 握手, server 工具以 mcp__<server>__<tool> 暴露
// 零依赖实现: spawn 子进程, stdin/stdout 按行交换 JSON-RPC; 请求带 id + 超时
import { spawn, ChildProcess } from "child_process";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";

  constructor(
    readonly serverName: string,
    private cfg: McpServerConfig,
    private log: (line: string) => void
  ) {}

  // 启动并完成 initialize 握手(失败抛错, 由调用方决定降级)
  async start(): Promise<void> {
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.cfg.env },
    });
    this.proc.on("error", (e) => this.failAll(new Error(`MCP server 启动失败: ${e.message}`)));
    this.proc.on("exit", (code) => this.failAll(new Error(`MCP server 退出(code=${code})`)));
    this.proc.stdout!.on("data", (d: Buffer) => this.onStdout(d));
    this.proc.stderr!.on("data", (d: Buffer) => this.log(`[mcp:${this.serverName}] stderr: ${d.toString().trim().slice(0, 120)}`));

    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-harness", version: "0.1.0" },
    }, INIT_TIMEOUT_MS);
    this.notify("notifications/initialized", {});
    this.log(`[mcp:${this.serverName}] 握手完成: ${result?.serverInfo?.name ?? "?"} ${result?.serverInfo?.version ?? ""}`.trim());
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this.request("tools/list", {}, CALL_TIMEOUT_MS);
    return (result?.tools ?? []) as McpToolDef[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
    // content 块取 text 拼接(对照: MCP 工具结果 content 数组)
    const text = (result?.content ?? [])
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("\n");
    return { text: text || JSON.stringify(result).slice(0, 2000), isError: result?.isError === true };
  }

  stop(): void {
    this.failAll(new Error("MCP server 已停止"));
    this.proc?.kill();
    this.proc = null;
  }

  // ── JSON-RPC 底层 ──

  private onStdout(d: Buffer): void {
    this.buffer += d.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // 末行可能不完整
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行(server 日志)忽略
      }
      if (msg.id == null) continue; // 通知/请求(未用)忽略
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP 错误: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error(`MCP server ${this.serverName} 未运行`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
