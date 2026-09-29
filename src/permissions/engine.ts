// 架构参考:权限瀑布 — 顺序严格, 任何 deny 层命中即终止:
//   ① deny 规则(激进规范化匹配)
//   ② 工具自身 checkPermissions(静态检查: 验证器 + 只读白名单)
//   ③ PreToolUse Hook(退出码 2 / stdout JSON 双协议)
//   ④ bypassPermissions 模式(危险, 默认关)
//   ⑤ ask 规则
//   ⑥ allow 规则(保守规范化匹配)
//   ⑦ auto 模式 LLM 分类器(两阶段)
//   ⑧ 用户弹窗(交互式 CLI 中渲染 UI; demo 中脚本化应答)
import { PermissionDecision } from "../types";
import { LLMProvider } from "../llm/provider";
import { HookRunner } from "../hooks/runner";
import { PermissionRules, checkRules } from "./rules";
import { classifyToolCall } from "./classifier";
import { Tool } from "../tools/tool";

export type PermissionMode = "default" | "bypassPermissions" | "auto" | "plan";

export interface EngineDeps {
  rules: PermissionRules;
  hooks: HookRunner;
  provider: LLMProvider;
  mode: PermissionMode;
  // 用户弹窗应答器(demo: 脚本化; chat: readline; web: 桥接浏览器弹窗)
  userResponder: (req: PermissionAsk) => Promise<"yes" | "no">;
  session: { sessionId: string; transcriptPath: string; cwd: string };
  log: (line: string) => void;
}

// 弹窗请求(结构化: 前端渲染工具名/入参/触发原因)
export interface PermissionAsk {
  toolName: string;
  toolInput: Record<string, unknown>;
  why: string;
}

export interface PermissionOutcome {
  decision: PermissionDecision;
  source: string; // waterfall 层标识: rule-deny / static / hook / bypass / rule-ask / rule-allow / classifier / user
  reason: string;
}

export class PermissionEngine {
  constructor(private deps: EngineDeps) {}

  // 设置热加载: settings.json 变更时替换规则引用(参考原版架构设置实时生效)
  updateRules(rules: PermissionRules): void {
    this.deps.rules = rules;
  }

  async check(
    tool: Tool,
    toolInput: Record<string, unknown>,
    userMessages: string[] // 供分类器盲视输入(用户消息逐字)
  ): Promise<PermissionOutcome> {
    const d = this.deps;
    const name = tool.name;

    // ① deny 规则
    const rules1 = checkRules({ allow: [], deny: d.rules.deny, ask: [] }, name, toolInput);
    if (rules1.decision === "deny") {
      await this.firePermissionDenied(name, toolInput, `rule: ${rules1.rule}`);
      return { decision: "deny", source: "rule-deny", reason: `命中 deny 规则 ${rules1.rule}` };
    }

    // ② 工具自身静态检查: deny/ask 立即处理; allow 先记录(待 Hook 之后返回, 保证 Hook 对放行工具也能审计)
    const staticCheck = tool.checkPermissions(toolInput);

    // ②'': plan 模式(对照: 原版架构 Plan mode 只读规划): 静态只读放行(Read/Glob/Grep/只读 Bash 白名单)之外一律拒
    if (d.mode === "plan" && staticCheck.decision !== "allow") {
      await this.firePermissionDenied(name, toolInput, "Plan 模式: 只读探索");
      return { decision: "deny", source: "plan-mode", reason: "Plan 模式: 只读探索, 副作用操作被拒绝" };
    }

    if (staticCheck.decision === "deny") {
      await this.firePermissionDenied(name, toolInput, staticCheck.reason ?? "static");
      return { decision: "deny", source: "static", reason: staticCheck.reason ?? "静态检查拒绝" };
    }
    if (staticCheck.decision === "ask") {
      const outcome = await this.askUser(name, toolInput, staticCheck.reason ?? "静态检查要求确认");
      if (outcome.decision === "deny") return outcome;
      return { decision: "allow", source: "user", reason: "用户确认放行(静态检查 ask)" };
    }

    // ③ PreToolUse Hook(放行的工具同样触发 — 审计/拦截均在执行前)
    const hook = await d.hooks.run("PreToolUse", { toolName: name, toolInput }, d.session);
    if (hook.decision === "deny") {
      await this.firePermissionDenied(name, toolInput, `hook: ${hook.feedback ?? ""}`);
      return {
        decision: "deny",
        source: "hook",
        reason: hook.feedback ?? "PreToolUse Hook 拒绝",
      };
    }
    if (hook.decision === "ask") {
      const outcome = await this.askUser(name, toolInput, hook.feedback ?? "Hook 要求用户确认");
      if (outcome.decision === "deny") return outcome;
      return { decision: "allow", source: "user", reason: "用户确认放行(Hook ask)" };
    }
    if (hook.decision === "allow") {
      return { decision: "allow", source: "hook", reason: hook.feedback ?? "PreToolUse Hook 放行" };
    }

    // ②': 静态只读白名单放行(在 Hook 之后返回)
    if (staticCheck.decision === "allow") {
      return { decision: "allow", source: "static", reason: staticCheck.reason ?? "只读白名单" };
    }

    // ④ bypassPermissions 模式(对照: --dangerously-skip-permissions)
    if (d.mode === "bypassPermissions") {
      return { decision: "allow", source: "bypass", reason: "bypassPermissions 模式" };
    }

    // ⑤ ask 规则
    const rules2 = checkRules({ allow: [], deny: [], ask: d.rules.ask }, name, toolInput);
    if (rules2.decision === "ask") {
      const outcome = await this.askUser(name, toolInput, `ask 规则 ${rules2.rule}`);
      if (outcome.decision === "deny") return outcome;
      return { decision: "allow", source: "user", reason: `用户确认放行(ask 规则 ${rules2.rule})` };
    }

    // ⑥ allow 规则
    const rules3 = checkRules({ allow: d.rules.allow, deny: [], ask: [] }, name, toolInput);
    if (rules3.decision === "allow") {
      return { decision: "allow", source: "rule-allow", reason: `命中 allow 规则 ${rules3.rule}` };
    }

    // ⑦ auto 模式分类器
    if (d.mode === "auto") {
      const r = await classifyToolCall(d.provider, userMessages, name, toolInput, d.log);
      if (r.decision === "deny") {
        await this.firePermissionDenied(name, toolInput, r.reason);
      }
      return { decision: r.decision, source: "classifier", reason: r.reason };
    }

    // ⑧ 用户弹窗(瀑布兜底)
    const outcome = await this.askUser(name, toolInput, "无规则命中, 需要用户确认");
    return outcome;
  }

  private async askUser(
    toolName: string,
    toolInput: Record<string, unknown>,
    why: string
  ): Promise<PermissionOutcome> {
    const d = this.deps;
    const answer = await d.userResponder({ toolName, toolInput, why });
    if (answer === "no") {
      await this.firePermissionDenied(toolName, toolInput, why);
      return { decision: "deny", source: "user", reason: `用户弹窗拒绝: ${why}` };
    }
    return { decision: "allow", source: "user", reason: `用户弹窗放行: ${why}` };
  }

  private async firePermissionDenied(
    toolName: string,
    toolInput: Record<string, unknown>,
    reason: string
  ): Promise<void> {
    // PermissionDenied 事件(demo 未配置 hook → 无操作)
    await this.deps.hooks.run("PermissionDenied", { toolName, toolInput }, this.deps.session);
  }
}
