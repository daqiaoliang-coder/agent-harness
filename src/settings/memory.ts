// 架构参考: Claude Code 项目记忆(CLAUDE.md)— 启动时读入并追加到系统提示, 项目级指令跨会话持久生效。
// 查找(序即拼接序, 双层):
//   ①用户级 <userDir>/CLAUDE.md — userDir 默认 AGENT_HARNESS_HOME ?? ~/.agent-harness(与 settings 分层同源重定向)
//   ②项目级 <projectRoot>/CLAUDE.md, 缺失则同级 fallback ③<projectRoot>/AGENTS.md(首个命中, ②命中则 ③ 不读)
// 语义与 settings 层对齐: 缺失 = 最常见形态, 静默跳过; 读失败(权限等)警告不 throw。
// 每文件 64K chars 软上限: 超限截断 + 尾注 + log 标记, 防巨型记忆文件无声挤爆上下文。
// 返回纯文本(不加固定头 — 头会污染 cache 前缀且无实证收益), 注入 composeSystemPrompt 的 memory 段
//   (段序: base → settings 追加段 → memory → CLI 追加 → 模式后缀)。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface MemorySource {
  path: string;
  chars: number; // 实际注入长度(截断后含尾注)
  truncated: boolean;
}

export interface ProjectMemory {
  text: string; // 命中文件内容按查找序 "\n\n" 拼接; 全缺失 → ""
  sources: MemorySource[]; // 诊断: 命中清单(测试与日志观测)
}

const MAX_MEMORY_CHARS = 64 * 1024;

export function loadProjectMemory(opts?: {
  userDir?: string;
  projectRoot?: string;
  log?: (line: string) => void;
}): ProjectMemory {
  const log = opts?.log ?? console.log;
  const projectRoot = opts?.projectRoot ?? process.cwd();
  const userDir = opts?.userDir ?? process.env.AGENT_HARNESS_HOME ?? path.join(os.homedir(), ".agent-harness");

  const projectClaude = path.join(projectRoot, "CLAUDE.md");
  // 候选序即拼接序; 项目级 CLAUDE.md 缺失才考虑同级 AGENTS.md(fallback 首个命中)
  const candidates = [path.join(userDir, "CLAUDE.md"), projectClaude];
  if (!fs.existsSync(projectClaude)) candidates.push(path.join(projectRoot, "AGENTS.md"));

  const sources: MemorySource[] = [];
  const texts: string[] = [];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue; // 缺失 = 正常形态, 静默
    let content: string;
    try {
      content = fs.readFileSync(p, "utf8");
    } catch (e) {
      log(`[memory] ${p}: 读取失败(已跳过): ${(e as Error).message}`);
      continue;
    }
    let truncated = false;
    if (content.length > MAX_MEMORY_CHARS) {
      truncated = true;
      content = `${content.slice(0, MAX_MEMORY_CHARS)}…(已截断, 原文 ${content.length} chars)`;
    }
    log(`[memory] ${p}(${content.length} chars)${truncated ? " [已截断]" : ""}`);
    sources.push({ path: p, chars: content.length, truncated });
    if (content.length > 0) texts.push(content); // 空文件计入 sources 诊断, 但不产生拼接段
  }
  return { text: texts.join("\n\n"), sources };
}
