// 对照: T3 渐进折叠 — 90/92/94% 每涨 2% 折叠一个"逻辑段"为 LLM 摘要(渐进退化,
// 用侧查询而非全量压缩, 为 T4 争取轮次); 已折叠的段不再重复折叠
import { Message, TextBlock } from "../types";
import { estimateConversationTokens, estimateTokens } from "../context/tokenEstimator";
import { LLMProvider } from "../llm/provider";
import { sideQuery } from "../sidequery/sideQuery";
import { CompactConfig, Watermarks } from "./watermarks";

export interface CollapseState {
  firedLevels: number[];
}

const COLLAPSED_PREFIX = "[context collapse]";

export interface CollapseResult {
  messages: Message[];
  state: CollapseState;
  folded: boolean;
}

export async function contextCollapse(
  messages: Message[],
  cfg: CompactConfig,
  wm: Watermarks,
  provider: LLMProvider,
  state: CollapseState,
  log: (line: string) => void
): Promise<CollapseResult> {
  const tokens = estimateConversationTokens(messages);
  const pct = tokens / wm.effectiveWindow;

  // 找到第一个未到达过的水位(每涨 2% 折叠一段)
  const level = cfg.collapseLevels.find((l) => pct >= l && !state.firedLevels.includes(l));
  if (level === undefined) {
    return { messages, state, folded: false };
  }

  // 折叠最老逻辑段: 从第一条非折叠 user 消息起, 到下一条 user 消息前
  // (跳过已被 T0/T1/T2 压缩过的小段 — 折叠收益过小不值得一次 LLM 调用)
  const MIN_SEGMENT_TOKENS = 600;
  let start = -1;
  let end = messages.length;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user" || isCollapsed(messages[i])) continue;
    // 找该段的结束边界(下一条非折叠 user 消息)
    let segEnd = messages.length;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "user" && !isCollapsed(messages[j])) {
        segEnd = j;
        break;
      }
    }
    if (estimateConversationTokens(messages.slice(i, segEnd)) >= MIN_SEGMENT_TOKENS) {
      start = i;
      end = segEnd;
      break;
    }
  }
  if (start === -1) {
    state.firedLevels.push(level); // 无足量可折叠段, 标记已处理
    log(`[compact] T3 collapse: ${(level * 100).toFixed(0)}% 水位无可折叠段(均已压缩/过小)`);
    return { messages, state, folded: false };
  }

  const segment = messages.slice(start, end);
  const segTokens = estimateConversationTokens(segment);

  // LLM 侧查询折叠摘要
  const summary = await sideQuery(
    provider,
    ["[[COLLAPSE]] 你是上下文折叠器。将以下对话段压缩为 1-2 句关键信息摘要, 保留任何决策、错误与未完成事项:"],
    [{ role: "user", content: [{ type: "text", text: JSON.stringify(segment) }] }],
    { maxTokens: 256, log }
  );

  const foldedMsg: Message = {
    role: "user",
    content: [{ type: "text", text: `${COLLAPSED_PREFIX} ${summary}` } as TextBlock],
  };
  const out = [...messages.slice(0, start), foldedMsg, ...messages.slice(end)];
  state.firedLevels.push(level);

  log(
    `[compact] T3 collapse: ${(level * 100).toFixed(0)}% 水位折叠 1 段 ` +
      `(段内 ${segment.length} 条消息 ${segTokens} tokens → 摘要 ${estimateTokens(summary)} tokens)`
  );
  return { messages: out, state, folded: true };
}

function isCollapsed(m: Message): boolean {
  return m.content.some(
    (b) => b.type === "text" && b.text.startsWith(COLLAPSED_PREFIX)
  );
}
