// 诊断回灌: lint/test/build 类命令失败 → 会话级缓冲 → 下一条用户消息注入未解决项提醒,
// 模型无需自行记住失败命令(自纠偏的关键输入); 同命令成功重跑即消解
export interface DiagnosticEntry {
  command: string;
  tail: string; // 失败输出尾部(诊断信息通常在末尾)
}

// 判定命令是否为"验证类"(失败意味着工作未完成): 包管理器 test/run/ci、tsc/eslint/vitest/jest/mocha/pytest、
// go test/vet、cargo test/check/build、make、mvn/gradle
const DIAGNOSTIC_RE =
  /(^|\s)(npm|yarn|pnpm|bun)\s+(test|run|ci)\b|npx\s+\S*(tsc|eslint|vitest|jest)|(^|\s)(tsc|eslint|vitest|jest|mocha|pytest)\b|\bgo\s+(test|vet)\b|\bcargo\s+(test|check|build)\b|(^|\s)make\b|(^|\s)(mvn|gradle)\b/;

export function isDiagnosticCommand(command: string): boolean {
  return DIAGNOSTIC_RE.test(command);
}

const MAX_ENTRIES = 3; // 提醒上限(最多 3 条未解决项; 更多覆盖最旧)
const TAIL_CHARS = 250; // 每条保留失败输出尾部字符数

export class DiagnosticsBuffer {
  private entries = new Map<string, DiagnosticEntry>(); // key = 命令原文(upsert 语义)

  // 记录一次命令结果: 非诊断命令 no-op; 成功 → 消解(删除); 失败 → upsert(保留输出尾部)
  record(command: string, ok: boolean, output: string): void {
    if (!isDiagnosticCommand(command)) return;
    if (ok) {
      this.entries.delete(command);
      return;
    }
    this.entries.set(command, { command, tail: output.slice(-TAIL_CHARS) });
    // 超上限: 淘汰最旧(Map 保持插入序; 重设 key 会刷新到尾部 → 最新失败优先保留)
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get unresolved(): DiagnosticEntry[] {
    return [...this.entries.values()];
  }

  // 渲染注入文本(无未解决项 → 空串不注入)
  render(): string {
    const items = this.unresolved;
    if (items.length === 0) return "";
    const lines = items.map((e) => `- \`${e.command}\` → 尾部输出: ${e.tail.replace(/\s+/g, " ").slice(0, 120)}`);
    return (
      `[诊断提醒] 截至上一轮, 以下验证命令未通过, 请先修复或明确说明跳过理由:\n${lines.join("\n")}`
    );
  }
}
