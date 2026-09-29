// 架构参考:的 permission rules 匹配 + 非对称环境变量剥离
//   allow 匹配前: 只剥"安全"环境变量前缀(保守 — 宁可不匹配也不放行)
//   deny 匹配前: 对环境变量赋值与 sudo/timeout/nohup 包装器做不动点迭代全剥(激进 — 让 deny 看穿伪装)
//   PATH/LD_PRELOAD/DYLD_*/PYTHONPATH/NODE_OPTIONS/BASH_ENV 永不剥
import { PermissionDecision } from "../types";

export interface PermissionRules {
  allow: string[]; // 形如 "Bash(seq:*)" / "Read"
  deny: string[];
  ask: string[];
}

interface ParsedRule {
  tool: string;
  prefix: string | null; // Bash 命令前缀; null = 匹配任意参数
}

function parseRule(rule: string): ParsedRule | null {
  const m = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (!m) return null;
  const spec = m[2];
  if (spec === undefined) return { tool: m[1], prefix: null };
  // "seq:*" → 前缀 seq + 通配; "rm -rf:*" → 前缀 "rm -rf" + 通配
  const colon = spec.lastIndexOf(":");
  const prefix = colon >= 0 ? spec.slice(0, colon) : spec;
  return { tool: m[1], prefix: prefix.trim() };
}

// 永不剥的危险变量(影响解释器/动态链接行为的都算)
const NEVER_STRIP: RegExp[] = [
  /^PATH=/,
  /^LD_PRELOAD=/,
  /^LD_LIBRARY_PATH=/,
  /^DYLD_[A-Z_]+=/,
  /^PYTHONPATH=/,
  /^PYTHONHOME=/,
  /^NODE_OPTIONS=/,
  /^BASH_ENV=/,
  /^ENV=/,
  /^IFS=/,
  /^SHELL=/,
];

// 安全变量白名单(allow 匹配前允许剥离)
const SAFE_ENV: RegExp[] = [
  /^RUST_BACKTRACE=/,
  /^RUST_LOG=/,
  /^NO_COLOR=/,
  /^CLICOLOR=/,
  /^CLICOLOR_FORCE=/,
  /^FORCE_COLOR=/,
  /^CI=/,
  /^LOG_LEVEL=/,
  /^DEBUG=/,
];

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/;
const WRAPPER = /^(sudo|nohup|command|env|nice|stdbuf)(\s+-[\w-]+|\s+\d+)*\s+/;

function stripEnv(cmd: string, safeOnly: boolean): string {
  let out = cmd;
  for (;;) {
    const assign = out.match(ENV_ASSIGN);
    if (!assign) break;
    const isSafe = SAFE_ENV.some((r) => r.test(assign[0]));
    const isNever = NEVER_STRIP.some((r) => r.test(assign[0]));
    if (isNever || (safeOnly && !isSafe)) break; // 不剥 → 前缀不匹配(保守)
    out = out.slice(assign[0].length);
  }
  return out.trimStart();
}

// allow 匹配前的规范化: 只剥安全变量
export function normalizeForAllow(command: string): string {
  return stripEnv(command, true);
}

// deny 匹配前的规范化: 剥全部可剥变量 + 包装器不动点迭代(sudo/timeout/nohup 全看穿)
export function normalizeForDeny(command: string): string {
  let prev = "";
  let out = command;
  while (prev !== out) {
    prev = out;
    out = stripEnv(out, false);
    out = out.replace(WRAPPER, "");
  }
  return out;
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  if (prefix === "*") return true;
  // 词边界前缀匹配: "seq 1 50000" 匹配 "seq", 不匹配 "seq2 ..."
  return command === prefix || command.startsWith(prefix + " ");
}

export type RuleMode = "allow" | "deny";

export function matchRule(
  rules: string[],
  mode: RuleMode,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (!parsed || parsed.tool !== toolName) continue;
    if (toolName === "Bash" && parsed.prefix !== null) {
      const command = String(toolInput.command ?? "");
      // 非对称剥离: deny 列表激进看穿伪装(包装器/变量全剥), allow 列表保守只剥安全变量
      const normalized = mode === "deny" ? normalizeForDeny(command) : normalizeForAllow(command);
      if (commandMatchesPrefix(normalized, parsed.prefix)) {
        return rule;
      }
      continue;
    }
    // 非 Bash 工具: 规则名匹配即命中(任意参数)
    return rule;
  }
  return null;
}

export type RuleCheck = PermissionDecision | null;

export function checkRules(
  rules: PermissionRules,
  toolName: string,
  toolInput: Record<string, unknown>
): { decision: RuleCheck; rule?: string } {
  // 顺序严格: deny 永远最先(且用激进规范化)
  const deny = matchRule(rules.deny, "deny", toolName, toolInput);
  if (deny) return { decision: "deny", rule: deny };
  // ask 列表用保守规范化(与 allow 同语义: 不确定就不命中)
  const ask = matchRule(rules.ask, "allow", toolName, toolInput);
  if (ask) return { decision: "ask", rule: ask };
  const allow = matchRule(rules.allow, "allow", toolName, toolInput);
  if (allow) return { decision: "allow", rule: allow };
  return { decision: null };
}
