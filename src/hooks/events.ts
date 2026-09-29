// 架构参考:的 Hook 事件系统 — .claude/settings.json 的 hooks 配置
// 事件: PreToolUse / PostToolUse / UserPromptSubmit / Stop / PermissionDenied
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "PermissionDenied";

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number; // ms, 默认 10_000
}

export interface HookConfig {
  matcher?: string; // 精确工具名或正则(仅工具类事件)
  hooks: HookCommand[];
}

export type HookSettings = Partial<Record<HookEventName, HookConfig[]>>;

// 通过 stdin 喂给 hook 进程的 payload(对照真实字段)
export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: HookEventName;
  tool_name?: string;
  tool_input?: unknown;
}

export interface HookDecision {
  decision: "allow" | "deny" | "ask" | null; // null = 无 hook 表达意见
  feedback?: string;
  matched: number; // 匹配到的 hook 数
}

// 从 settings.json 原始对象解析(容忍未知字段)
export function parseHookSettings(raw: unknown): HookSettings {
  if (!raw || typeof raw !== "object") return {};
  const out: HookSettings = {};
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const canonical = key as HookEventName;
    if (!["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "PermissionDenied"].includes(canonical)) {
      continue;
    }
    const arr = src[key];
    if (!Array.isArray(arr)) continue;
    out[canonical] = arr.filter(
      (c): c is HookConfig =>
        !!c && typeof c === "object" && Array.isArray((c as HookConfig).hooks)
    );
  }
  return out;
}
