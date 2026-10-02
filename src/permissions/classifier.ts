// 对照: auto 模式 LLM 权限分类器(Anthropic 2026-03 工程博客)
// 两阶段: Stage1 单 token block/allow(宁错杀, 低 FNR, 便宜) → 命中 block 才进
//         Stage2 CoT 复审(降 FPR); Stage1 放行则直接放行
// 推理盲视: 输入只含用户消息 + 待批工具调用, 不含系统提示/历史工具结果 → 防注入
// 分类器不可用 → fail-closed 拦截
import { LLMProvider } from "../llm/provider";
import { sideQuery } from "../sidequery/sideQuery";

const STAGE1_SYSTEM = `[[CLASSIFIER_STAGE1]] 你是命令安全快筛器。判断该工具调用是否可能有风险。
只输出一个词: block 或 allow。不确定时输出 block(宁可错杀)。`;

const STAGE2_SYSTEM = `[[CLASSIFIER_STAGE2]] 你是命令安全复审器。Stage1 已标记 block, 请仔细推理后裁决。
先逐步推理(风险向量: 任意代码执行/数据破坏/提权/外泄), 最后输出一行 JSON: {"decision":"allow"|"deny","reason":"..."}`;

export interface ClassifyResult {
  decision: "allow" | "deny";
  reason: string;
  stage: 1 | 2;
}

export async function classifyToolCall(
  provider: LLMProvider,
  userMessages: string[], // 用户消息(逐字) — 推理盲视的唯一上下文来源之一
  toolName: string,
  toolInput: Record<string, unknown>,
  log: (line: string) => void,
  signal?: AbortSignal
): Promise<ClassifyResult> {
  // 构造盲视输入: 用户消息 + 工具调用, 不含系统提示与历史
  const blindInput =
    userMessages.map((t) => `[user] ${t}`).join("\n") +
    `\n[tool call] ${toolName}(${JSON.stringify(toolInput)})`;

  try {
    // Stage1: 单 token, maxTokens 压到最小
    const s1 = await sideQuery(
      provider,
      [STAGE1_SYSTEM],
      [{ role: "user", content: [{ type: "text", text: blindInput }] }],
      { maxTokens: 4, signal }
    );
    // 容错解析: 真实模型可能输出 "Block." / "block\n" 等
    const verdict = (s1.toLowerCase().match(/\b(allow|block)\b/) ?? [])[0];
    if (verdict === "allow") {
      log(`[perm] auto 分类器 Stage1 → allow → 放行(快路径)`);
      return { decision: "allow", reason: "分类器 Stage1 放行", stage: 1 };
    }
    // block 或输出不可解析 → 进 Stage2 复审(宁谨慎; 不可解析时不清真伪)
    log(
      verdict === "block"
        ? `[perm] auto 分类器 Stage1 → block → 进入 Stage2 复审`
        : `[perm] auto 分类器 Stage1 输出不可解析(${s1.trim().slice(0, 20) || "空"}) → 谨慎进入 Stage2`
    );
    // Stage2: CoT 复审
    const s2 = await sideQuery(
      provider,
      [STAGE2_SYSTEM],
      [{ role: "user", content: [{ type: "text", text: blindInput }] }],
      { maxTokens: 512, signal }
    );
    const jsonMatch = s2.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 解析失败 → fail-closed
      log(`[perm] auto 分类器 Stage2 输出无法解析 → fail-closed 拦截`);
      return { decision: "deny", reason: "分类器 Stage2 输出不可解析(fail-closed)", stage: 2 };
    }
    const parsed = JSON.parse(jsonMatch[0]) as { decision?: string; reason?: string };
    const decision = parsed.decision === "allow" ? "allow" : "deny";
    log(`[perm] auto 分类器 Stage1 → block; Stage2 复审 → ${decision} (${parsed.reason ?? ""})`);
    return { decision, reason: `分类器两阶段: ${parsed.reason ?? decision}`, stage: 2 };
  } catch (e) {
    // 分类器不可用 → fail-closed 拦截(不静默放行)
    log(`[perm] auto 分类器不可用(${(e as Error).message}) → fail-closed 拦截`);
    return { decision: "deny", reason: `分类器不可用, fail-closed: ${(e as Error).message}`, stage: 1 };
  }
}
