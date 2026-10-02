// Slash 命令注册表 — CLI(chat REPL)与 Web(/api/message)共用的用户命令层。
// 架构参考: Claude Code 内置 slash 命令(/help /status /mode …); 此处抽成独立注册表,
//   两端只各建一个 CommandContext(输出通道不同: CLI → console; Web → command_output 事件)。
// 语义约定: "/" 开头即命令域 — 未知命令报错且不发给 LLM(防误投);
//   非 "/" 文本 → dispatchSlashCommand 返回 false, 调用方走正常 send 链路。
import { PermissionMode } from "./permissions/engine";

export const PERMISSION_MODES: PermissionMode[] = ["default", "auto", "plan", "bypassPermissions"];

// Plan 模式系统提示后缀(单一信息来源: createSession 按 mode 组装, setMode 运行中动态增删)
export const PLAN_MODE_SUFFIX =
  "当前处于 Plan 模式: 只读探索与规划, 不要尝试修改文件或执行副作用命令; 结束时给出实施计划。";

export interface CommandContext {
  getMode(): PermissionMode;
  // 双通道即时: 权限引擎 + 系统提示(plan 后缀)同轮生效; 实现方负责日志与 mode_changed 事件
  setMode(mode: PermissionMode): void;
  status(): string;
  permissionsSummary(): string;
  usageSummary(): string;   // 最近 5h 用量窗口(telemetry.usageStats 格式化)
  log(line: string): void; // 命令输出通道
  exit(): void;            // CLI 关 readline; Web 无进程可退 → 提示关标签页
}

export interface SlashCommand {
  name: string;
  description: string;
  run(args: string, ctx: CommandContext): void;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "列出可用命令",
    run: (_args, ctx) => {
      ctx.log("[commands] 可用命令:");
      for (const c of BUILTIN_COMMANDS) ctx.log(`  /${c.name.padEnd(13)} ${c.description}`);
    },
  },
  {
    name: "status",
    description: "会话状态: 模式/轮次/累计 tokens/错误/transcript",
    run: (_args, ctx) => ctx.log(ctx.status()),
  },
  {
    name: "mode",
    description: "显示或切换权限模式(default|auto|plan|bypassPermissions)",
    run: (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.log(`[mode] 当前: ${ctx.getMode()} | 可切换: ${PERMISSION_MODES.join(" | ")}(bypassPermissions 需 --dangerous 确认)`);
        return;
      }
      const mode = parts[0] as PermissionMode;
      if (!PERMISSION_MODES.includes(mode)) {
        ctx.log(`[mode] 未知模式: ${mode} | 可选: ${PERMISSION_MODES.join(" | ")}`);
        return;
      }
      // bypassPermissions 跳过全部权限确认 = 任意命令直exec, 须显式二次确认(防 UI 误触/token 泄露场景)
      if (mode === "bypassPermissions" && !parts.includes("--dangerous")) {
        ctx.log("[mode] bypassPermissions 将跳过所有权限确认(高风险)。确认请追加 --dangerous: /mode bypassPermissions --dangerous");
        return;
      }
      ctx.setMode(mode);
    },
  },
  {
    name: "permissions",
    description: "权限规则概览(分层合并 + 会话级记忆)",
    run: (_args, ctx) => ctx.log(ctx.permissionsSummary()),
  },
  {
    name: "usage",
    description: "最近 5h 用量窗口(调用数/tokens 分解/会话数)",
    run: (_args, ctx) => ctx.log(ctx.usageSummary()),
  },
  {
    name: "exit",
    description: "退出(CLI); Web 端直接关闭浏览器标签页即可",
    run: (_args, ctx) => ctx.exit(),
  },
];

// 统一调度: text 以 "/" 开头 → 查表执行(未知 → 报错); 否则返回 false(正常发给 LLM)
export function dispatchSlashCommand(text: string, ctx: CommandContext): boolean {
  if (!text.startsWith("/")) return false;
  const name = (text.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
  const cmd = BUILTIN_COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    ctx.log(`[commands] 未知命令: /${name}(用 /help 查看可用命令)`);
    return true;
  }
  cmd.run(text.slice(1).split(/\s+/).slice(1).join(" "), ctx);
  return true;
}
