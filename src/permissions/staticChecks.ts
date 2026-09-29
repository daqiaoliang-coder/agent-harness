// 架构参考:中 Bash 工具自带 20+ 正则验证器(此为代表性子集) + 只读命令白名单
// git push/reset 等破坏性 git 操作永不自动批(降级为 ask)
import { PermissionDecision } from "../types";

interface Validator {
  name: string;
  pattern: RegExp;
  decision: Exclude<PermissionDecision, "allow"> | "allow";
  reason: string;
}

const DENY_VALIDATORS: Validator[] = [
  { name: "rm-递归删除根/家/通配", pattern: /\brm\s+[^|;&>]*-[a-zA-Z]*[rf][a-zA-Z]*f?[^|;&>]*(\s\/(\s|$)|\s\/~|\s\*(\s|$)|\s~\/)/, decision: "deny", reason: "递归删除危险目标(/ ~ *)" },
  { name: "sudo", pattern: /(^|\s|;|&&|\|\|)\s*sudo\s/, decision: "deny", reason: "提权命令" },
  { name: "curl/wget 管道执行", pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/, decision: "deny", reason: "远程内容直接管道进 shell" },
  { name: "覆写块设备", pattern: /\bdd\s+[^;]*of=\/dev\/(sda|sd[a-z]|disk|nvme)/, decision: "deny", reason: "dd 写块设备" },
  { name: "格式化", pattern: /\bmkfs(\.\w+)?\b/, decision: "deny", reason: "格式化文件系统" },
  { name: "fork 炸弹", pattern: /:\(\)\s*\{.*\};\s*:/, decision: "deny", reason: "fork 炸弹" },
  { name: "chmod 777 根目录", pattern: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, decision: "deny", reason: "递归放开根目录权限" },
  { name: "eval base64", pattern: /\beval\s+["']?[A-Za-z0-9+/=]{40,}/, decision: "deny", reason: "eval 混淆长串(疑似编码载荷)" },
  { name: "清空 shell 历史", pattern: /\bhistory\s+-c\b|\bshred\b[^;]*\/(etc|home)/, decision: "deny", reason: "清除痕迹类操作" },
];

const ASK_VALIDATORS: Validator[] = [
  { name: "git push --force", pattern: /\bgit\s+push\b[^;|&]*(-f|--force)/, decision: "ask", reason: "git push 强推永不自动批" },
  { name: "git reset --hard", pattern: /\bgit\s+reset\s+--hard\b/, decision: "ask", reason: "git reset --hard 永不自动批" },
];

// 只读命令白名单(自动放行): 所有管道段都必须只读
const READONLY_COMMANDS = new Set(["cat", "head", "tail", "ls", "wc", "diff", "pwd", "whoami", "echo", "grep", "find"]);
const READONLY_GIT = new Set(["diff", "status", "log", "show"]);

export interface StaticCheckResult {
  decision: PermissionDecision | null; // null = 无意见, 交给瀑布下一层
  reason?: string;
}

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isReadonlySegment(seg: string): boolean {
  const tokens = seg.split(/\s+/);
  const cmd = tokens[0];
  if (READONLY_COMMANDS.has(cmd)) return true;
  if (cmd === "git" && tokens.length > 1 && READONLY_GIT.has(tokens[1])) return true;
  return false;
}

export function checkBashCommand(command: string): StaticCheckResult {
  for (const v of DENY_VALIDATORS) {
    if (v.pattern.test(command)) {
      return { decision: "deny", reason: `静态检查: ${v.name} (${v.reason})` };
    }
  }
  for (const v of ASK_VALIDATORS) {
    if (v.pattern.test(command)) {
      return { decision: "ask", reason: `静态检查: ${v.name} (${v.reason})` };
    }
  }
  // 只读白名单: 所有段都只读才放行
  const segs = segments(command);
  if (segs.length > 0 && segs.every(isReadonlySegment)) {
    return { decision: "allow", reason: "静态检查: 只读命令白名单" };
  }
  return { decision: null };
}
