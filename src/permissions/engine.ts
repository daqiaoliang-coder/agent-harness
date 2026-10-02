// 架构参考:权限瀑布 — 顺序严格, 任何 deny 层命中即终止:
//   ① deny 规则(激进规范化匹配)
//   ② 工具自身 checkPermissions(静态检查: 验证器 + 只读白名单)
//   ③ PreToolUse Hook(退出码 2 / stdout JSON 双协议)
//   ④ bypassPermissions 模式(危险, 默认关)
//   ⑤' 会话级记忆规则(弹窗"总是允许"累积; 用户当次表态压过 ask 规则, deny/静态/Hook 均在前)
//   ⑤ ask 规则
//   ⑥ allow 规则(保守规范化匹配)
//   ⑦ auto 模式 LLM 分类器(两阶段)
//   ⑧ 用户弹窗(交互式 CLI 中渲染 UI; demo 中脚本化应答)
import { PermissionDecision } from "../types";
import { LLMProvider } from "../llm/provider";
import { HookRunner } from "../hooks/runner";
import { PermissionRules, checkRules, matchRule } from "./rules";
import { classifyToolCall } from "./classifier";
import { Tool } from "../tools/tool";
import { buildPermissionPreview, deriveAlwaysRule, PermissionPreview } from "./preview";

export type PermissionMode = "default" | "bypassPermissions" | "auto" | "plan";

// 弹窗应答: yes=本次允许 | no=本次拒绝 | always=允许并会话内记住(引擎推导记忆规则)
export type PermissionAnswer = "yes" | "no" | "always";

export interface EngineDeps {
  rules: PermissionRules;
  hooks: HookRunner;
  provider: LLMProvider;
  mode: PermissionMode;
  // 用户弹窗应答器(demo: 脚本化; chat: readline; web: 桥接浏览器弹窗)
  userResponder: (req: PermissionAsk) => Promise<PermissionAnswer>;
  session: { sessionId: string; transcriptPath: string; cwd: string };
  log: (line: string) => void;
}

// 弹窗请求(结构化: 前端渲染工具名/入参/触发原因)
export interface PermissionAsk {
  toolName: string;
  toolInput: Record<string, unknown>;
  why: string;
  // Edit/Write 的 diff 预览(权限时刻构建, 不触碰 fileState; 其他工具无 → UI 回落 JSON)
  preview?: PermissionPreview;
  // 选择"总是允许"将记住的规则(undefined = 本次不提供该选项: 静态/Hook ask 路径记忆无法生效)
  alwaysRule?: string;
  // 中断信号(可选): CLI 应答器可用其在中断时自动收尾挂起的输入等待
  signal?: AbortSignal;
}

export interface PermissionOutcome {
  decision: PermissionDecision;
  source: string; // waterfall 层标识: rule-deny / static / hook / bypass / rule-ask / rule-allow / classifier / user
  reason: string;
}

export class PermissionEngine {
  // 会话级"总是允许"记忆(弹窗选 always 后累积): 规则语法同 settings, 仅内存态 —
  // 不落盘、不进 settings、新会话不继承; updateRules 热加载只换 deps.rules, 不清洗本表
  private sessionAllows: string[] = [];

  constructor(private deps: EngineDeps) {}

  // 设置热加载: settings.json 变更时替换规则引用(参考原版架构设置实时生效)
  updateRules(rules: PermissionRules): void {
    this.deps.rules = rules;
  }

  // 运行中模式切换(/mode; 参考架构 shift+tab 循环): 纯 deps.mode 替换, 类比 updateRules 热加载。
  // 不清洗 sessionAllows — 用户明确授权过的操作不因模式切换失效(deny/静态/Hook 均在记忆层之前)
  updateMode(mode: PermissionMode): void {
    this.deps.mode = mode;
  }

  // 只读访问器: /mode 无参显示与 Web 徽章实时读取(不再依赖创建时快照)
  get mode(): PermissionMode {
    return this.deps.mode;
  }

  get ruleCounts(): { allow: number; deny: number; ask: number } {
    return {
      allow: this.deps.rules.allow.length,
      deny: this.deps.rules.deny.length,
      ask: this.deps.rules.ask.length,
    };
  }

  get sessionAllowCount(): number {
    return this.sessionAllows.length;
  }

  async check(
    tool: Tool,
    toolInput: Record<string, unknown>,
    userMessages: string[], // 供分类器盲视输入(用户消息逐字)
    signal?: AbortSignal // 用户中断信号: 中断等待弹窗应答/分类器查询
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
      // 静态 ask(如 git push --force)不提供"总是允许": 会话记忆检查在其后, 记忆无法生效
      const outcome = await this.askUser(name, toolInput, staticCheck.reason ?? "静态检查要求确认", signal, false);
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
      // Hook ask 不提供"总是允许"(记忆检查在其后, 提供也不生效)
      const outcome = await this.askUser(name, toolInput, hook.feedback ?? "Hook 要求用户确认", signal, false);
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

    // ⑤' 会话级记忆(弹窗"总是允许"累积): 置于 ask 规则之前 —
    // 用户当次明确表态应压过 settings 的 ask 规则; deny 规则/静态检查/Hook 均在前, 安全层保留
    if (this.sessionAllows.length > 0) {
      const hit = matchRule(this.sessionAllows, "allow", name, toolInput);
      if (hit) {
        return { decision: "allow", source: "session-allow", reason: `会话内已总是允许 ${hit}` };
      }
    }

    // ⑤ ask 规则
    const rules2 = checkRules({ allow: [], deny: [], ask: d.rules.ask }, name, toolInput);
    if (rules2.decision === "ask") {
      const outcome = await this.askUser(name, toolInput, `ask 规则 ${rules2.rule}`, signal, true);
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
      const r = await classifyToolCall(d.provider, userMessages, name, toolInput, d.log, signal);
      if (r.decision === "deny") {
        await this.firePermissionDenied(name, toolInput, r.reason);
      }
      return { decision: r.decision, source: "classifier", reason: r.reason };
    }

    // ⑧ 用户弹窗(瀑布兜底)
    const outcome = await this.askUser(name, toolInput, "无规则命中, 需要用户确认", signal, true);
    return outcome;
  }

  private async askUser(
    toolName: string,
    toolInput: Record<string, unknown>,
    why: string,
    signal?: AbortSignal,
    offerAlways = false
  ): Promise<PermissionOutcome> {
    const d = this.deps;
    if (signal?.aborted) {
      return { decision: "deny", source: "abort", reason: "用户中断, 权限等待取消" };
    }
    // 弹窗前构建人类可读预览(Edit/Write diff; 不触碰 fileState)与 always 记忆规则
    const preview = buildPermissionPreview(toolName, toolInput, d.session.cwd);
    const alwaysRule = offerAlways ? deriveAlwaysRule(toolName, toolInput) : undefined;
    // 用户弹窗与中断信号 race: 中断时视作拒绝(挂起的弹窗 Promise 可能永不 resolve —
    // Web 端浏览器无人应答, CLI 端中断优先于等待输入)
    let answer: PermissionAnswer | "aborted";
    if (signal) {
      answer = await Promise.race([
        d.userResponder({ toolName, toolInput, why, preview, alwaysRule, signal }),
        new Promise<"aborted">((resolve) =>
          signal.addEventListener("abort", () => resolve("aborted"), { once: true })
        ),
      ]);
      if (answer === "aborted") {
        return { decision: "deny", source: "abort", reason: "用户中断, 权限等待取消" };
      }
    } else {
      answer = await d.userResponder({ toolName, toolInput, why, preview, alwaysRule });
    }
    if (answer === "no") {
      await this.firePermissionDenied(toolName, toolInput, why);
      return { decision: "deny", source: "user", reason: `用户弹窗拒绝: ${why}` };
    }
    if (answer === "always" && alwaysRule) {
      // 会话级记忆: 后续同前缀/同工具命中 ⑤' 层直接放行(仅本会话, 不落盘)
      if (!this.sessionAllows.includes(alwaysRule)) this.sessionAllows.push(alwaysRule);
      d.log(`[perm] 会话内总是允许: ${alwaysRule}(后续同类操作免确认)`);
      return { decision: "allow", source: "user", reason: `用户弹窗放行 + 会话记忆 ${alwaysRule}: ${why}` };
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
