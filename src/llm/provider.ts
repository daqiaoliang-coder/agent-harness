// 架构参考:的 provider 层(流式 + 多模型路由); 此处 MockProvider 脚本化轮次, 无需 API key
// 真实 prompt 为自然语言; mock 用 [[标记]] 路由侧查询(分类器/折叠/压缩摘要)
import { ContentBlock, Message } from "../types";
import { ToolSchema } from "../context/cacheBoundary";
import { estimateTokens } from "../context/tokenEstimator";

export interface CompleteOptions {
  maxTokens: number;
  // 主循环传入工具定义(真实 provider 需要; Mock 忽略)
  tools?: ToolSchema[];
  // 用户中断信号(Ctrl-C / Web 停止): 中断中的请求以 RunAbortedError 抛出, 不重试
  signal?: AbortSignal;
}

// 真实 API 的用量统计(prompt cache 遥测)
export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CompleteResult {
  message: Message;
  usage?: UsageInfo;
}

// 流式选项: 文本增量回调(渐进渲染; 工具入参的 json 增量不外露)
export interface StreamOptions extends CompleteOptions {
  onTextDelta?: (text: string) => void;
}

export interface LLMProvider {
  readonly name: string;
  complete(system: string[], messages: Message[], opts: CompleteOptions): Promise<CompleteResult>;
  // 流式(可选实现): SSE 聚合为完整 message 后返回; 未实现时调用方回退 complete
  completeStream?(system: string[], messages: Message[], opts: StreamOptions): Promise<CompleteResult>;
}

// 413 等价错误: 服务端认为 prompt 超限 → 触发 T5 reactive compact(真实 API 的 413/prompt_too_long 也映射到这里)
export class ContextWindowExceededError extends Error {
  constructor() {
    super("HTTP 413: prompt 超出上下文窗口");
    this.name = "ContextWindowExceededError";
  }
}

export interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ name: string; input: Record<string, unknown> }>;
  throw413?: boolean;
}

const AUTOCOMPACT_MOCK = `<analysis>
草稿: 会话从目录检查开始, 用户要求生成测试日志; 随后多轮粘贴服务日志要求分析;
期间触发多层压缩; 曾尝试 rm 清理被 Hook 拦截(尚未发生, 属于规划)。
关键文件: .agent-harness/artifacts/ 下的工具结果落盘文件。
</analysis>
<summary>
1. Primary Request and Intent: 用户要求检查目录结构、生成并分析测试日志, 并观察 harness 的压缩行为。
2. Technical Concepts: prompt cache 边界、五层压缩管线(T0-T5)、权限瀑布、PreToolUse Hook。
3. Files and Code Sections: .agent-harness/artifacts/(seq 大输出落盘); demo/settings.json(权限规则与 Hook 配置)。
4. Errors and fixes: 无错误; 大工具结果由 T0 预算层落盘。
5. Problem Solving: 通过分层压缩维持 buffer 在水位以下。
6. All user messages: 逐字保留: "帮我看看目录并跑一个测试日志"; "服务日志第 N 段: AAAA..."(共 11 段)。
7. Pending Tasks: 清理临时目录(待用户确认安全方式); 拉取并运行远程脚本(未执行)。
8. Current Work: 持续分析用户粘贴的服务日志段落。
9. Optional Next Step: 等待用户下一条指令。
</summary>`;

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private queue: ScriptedTurn[];
  private idx = 0;
  // 遥测: 侧查询调用计数(分类器/折叠/压缩)
  sideQueryCount = 0;
  mainCallCount = 0;

  constructor(queue: ScriptedTurn[]) {
    this.queue = queue;
  }

  async complete(system: string[], _messages: Message[], opts: CompleteOptions): Promise<CompleteResult> {
    const sys = system.join("\n");

    // ── 侧查询路由(真实实现按 prompt 语义区分, mock 用标记) ──
    if (sys.includes("[[CLASSIFIER_STAGE1]]")) {
      this.sideQueryCount++;
      // Stage1: 单 token 输出, 宁错杀(低 FNR)
      return this.text("block");
    }
    if (sys.includes("[[CLASSIFIER_STAGE2]]")) {
      this.sideQueryCount++;
      // Stage2: CoT 复审后输出 JSON(降 FPR)
      return this.text(
        '{"decision":"deny","reason":"远程下载脚本保存后用 bash 本地执行, 属于任意代码执行/供应链攻击向量"}'
      );
    }
    if (sys.includes("[[COLLAPSE]]")) {
      this.sideQueryCount++;
      return this.text("[折叠摘要] 该段为服务日志填充轮次, 无关键决策; 仅保留: 用户提供了日志段, 助手确认已分析。");
    }
    if (sys.includes("[[AUTOCOMPACT]]")) {
      this.sideQueryCount++;
      return this.text(AUTOCOMPACT_MOCK);
    }
    if (sys.includes("[[REACTIVE]]")) {
      this.sideQueryCount++;
      return this.text(
        "[reactive 摘要] 会话用于压缩管线演示; 最近 4 条为日志填充轮次与 413 恢复; 无未完成工具调用; 待办: 清理临时目录、远程脚本执行(均未执行)。"
      );
    }

    // ── 主循环脚本 ──
    this.mainCallCount++;
    const turn = this.queue[this.idx++];
    if (!turn) {
      return this.text("(mock 脚本队列已耗尽, 会话结束)");
    }
    if (turn.throw413) {
      // 模拟服务端容量拒绝(真实场景: 压缩后仍超限/服务端硬限)
      throw new ContextWindowExceededError();
    }
    const content: ContentBlock[] = [];
    if (turn.text) content.push({ type: "text", text: turn.text });
    (turn.toolUses ?? []).forEach((t, i) => {
      content.push({
        type: "tool_use",
        // 确定性 id(无随机数, 保 cache 字节稳定)
        id: `toolu_${String(this.idx).padStart(3, "0")}_${i}`,
        name: t.name,
        input: t.input,
      });
    });
    void opts;
    // 合成 usage(estimateTokens 口径): mock 链路的用量仪表盘/5h 窗口/预算累计有数据可测;
    // 侧查询(分类器/折叠/压缩摘要)不返回 usage — 与真实侧查询不进计费口径一致
    return {
      message: { role: "assistant", content },
      usage: {
        input_tokens: estimateTokens(sys + JSON.stringify(_messages)),
        output_tokens: estimateTokens(JSON.stringify(content)),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }

  private text(t: string): CompleteResult {
    return { message: { role: "assistant", content: [{ type: "text", text: t }] } };
  }
}
