// 架构参考: Task 工具的子代理机制 — 独立 context window + 受限工具集 + 上下文隔离
// (父上下文只收到最终报告, 子代理的中间过程不进父消息树 — 这是省 token 的核心)
// 此处实现 explore 型: 只读工具子集(Read/Glob/Grep), 不注册 Task(防无限嵌套), 不与用户交互
import * as fs from "fs";
import * as path from "path";
import { Message } from "../types";
import { LLMProvider } from "../llm/provider";
import { CompactConfig } from "../compact/watermarks";
import { PermissionRules } from "../permissions/rules";
import { PermissionEngine } from "../permissions/engine";
import { HookRunner } from "../hooks/runner";
import { parseHookSettings } from "../hooks/events";
import { ToolRegistry } from "../tools/tool";
import { ReadTool } from "../tools/read";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { estimateTokens } from "../context/tokenEstimator";
import { initLoopState, runQuery, QueryDeps } from "../query";

const SUB_SYSTEM_PROMPT = [
  "You are a read-only explore subagent (architecture reference implementation)。",
  "可用工具: Read(读文件), Glob(文件名匹配), Grep(内容搜索)。不可写文件、不可执行命令、不可派生子任务。",
  "完成任务后输出简明结论: 关键发现 + 相关文件路径。不要复述文件全文, 只给父代理需要的摘要。",
].join("\n");

export interface SubAgentOptions {
  provider: LLMProvider;
  cfg: CompactConfig; // 复用主会话压缩配置 → 子代理独立消息树 + 独立压缩管线
  rules: PermissionRules;
  artifactsDir: string;
  sessionsDir: string;
  cwd: string;
  log: (line: string) => void;
}

export function createExploreAgent(opts: SubAgentOptions): (prompt: string, maxTurns?: number, signal?: AbortSignal) => Promise<string> {
  return async (prompt: string, maxTurns = 12, signal?: AbortSignal): Promise<string> => {
    const sessionId = `sess_task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const transcriptPath = path.join(opts.sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "", "utf8");
    const session = { sessionId, transcriptPath, cwd: opts.cwd };

    // 受限工具集: 只读三件套; 不含 Bash/Write/Edit/Task(防嵌套)
    const tools = new ToolRegistry();
    tools.register(new ReadTool());
    tools.register(new GlobTool());
    tools.register(new GrepTool());

    const deps: QueryDeps = {
      provider: opts.provider,
      tools,
      permissions: new PermissionEngine({
        rules: opts.rules,
        hooks: new HookRunner(parseHookSettings({}), opts.cwd, opts.log), // 子代理不继承主 Hook(独立环境)
        provider: opts.provider,
        mode: "default",
        userResponder: async () => "no", // 子代理不与用户交互: 弹窗自动拒
        session,
        log: opts.log,
      }),
      hooks: new HookRunner(parseHookSettings({}), opts.cwd, opts.log),
      cfg: opts.cfg,
      systemPrompt: [SUB_SYSTEM_PROMPT],
      systemTokens: estimateTokens(SUB_SYSTEM_PROMPT),
      model: "agent-harness-subagent",
      artifactsDir: opts.artifactsDir,
      session,
      getUserMessages: () => [prompt],
      log: opts.log,
      signal, // 父级中断透传: 子代理的 LLM 调用/工具执行同轮中断
    };

    const state = initLoopState();
    const msg: Message = { role: "user", content: [{ type: "text", text: prompt }] };
    state.messages.push(msg);
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ ts: new Date().toISOString(), role: "user", content: msg.content }) + "\n",
      "utf8"
    );

    opts.log(`[task] 子代理启动 ${sessionId} | 只读工具集(Read/Glob/Grep) | maxTurns=${maxTurns}`);
    try {
      await runQuery(deps, state, "user", maxTurns);
    } catch (e) {
      return `子代理执行出错: ${(e as Error).message}\n(已完成的中间结果见 transcript ${transcriptPath})`;
    }
    // 最终报告 = 最后一条 assistant 消息的文本(上下文隔离: 只回传这一段)
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    const report =
      last?.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() || "(子代理无文本输出)";
    opts.log(`[task] 子代理完成 ${sessionId} | 报告 ${report.length} chars | transcript ${transcriptPath}`);
    return report;
  };
}
