// 架构参考: 工具输入形状校验 — 调度层按 inputSchema(JSON Schema 子集)前置检查
// 失败 → isError tool_result(模型下一轮自修正); 未知字段不拒绝, 仅文案提示(前向兼容)

export interface ValidationIssue {
  field: string;
  problem: string;
}

// 声明类型严格 typeof 对照(不做任何静默转换: "30000" 字符串不收、123 数字路径不收)
// 未声明 type / 复杂形状(anyOf 等, MCP schema 常见)→ 跳过类型检查(best-effort, required 照查)
function typeOk(declared: string, v: unknown): boolean {
  switch (declared) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    default:
      return true;
  }
}

// 错误描述: 类型 + 值预览(帮助模型定位自己发了什么)
function describe(v: unknown): string {
  const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (t === "string") return `string(${JSON.stringify((v as string).slice(0, 40))})`;
  if (t === "number" || t === "boolean") return `${t}(${String(v)})`;
  return t;
}

export function validateToolInput(schema: Record<string, unknown>, input: unknown): ValidationIssue[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [{ field: "(input)", problem: `tool_use.input 必须是 JSON 对象, 实际 ${describe(input)}` }];
  }
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const obj = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const f of required) {
    if (obj[f] === undefined || obj[f] === null) issues.push({ field: f, problem: "必填字段缺失" });
  }
  for (const k of Object.keys(obj)) {
    const declared = props[k]?.type;
    if (!declared || obj[k] === undefined || obj[k] === null) continue;
    if (!typeOk(declared, obj[k])) {
      issues.push({ field: k, problem: `类型应为 ${declared}, 实际 ${describe(obj[k])}` });
    }
  }
  return issues;
}

// 组装 tool_result 文案: 头行(全部问题一次给全, 不挤牙膏) + 未知字段提示 + 参数签名 → 模型单轮自修正
export function formatValidationIssues(
  toolName: string,
  schema: Record<string, unknown>,
  input: unknown,
  issues: ValidationIssue[]
): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const sig = Object.entries(props)
    .map(([k, p]) => `${k}: ${p?.type ?? "any"}${required.includes(k) ? "(必填)" : ""}`)
    .join(", ");
  const unknown =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.keys(input as Record<string, unknown>).filter((k) => !(k in props))
      : [];
  const lines = [`工具输入校验失败(${toolName}): ${issues.map((i) => `${i.field}: ${i.problem}`).join("; ")}。`];
  if (unknown.length > 0) {
    lines.push(`未知字段: ${unknown.join(", ")}(不在该工具 schema 中, 请核对参数名)。`);
  }
  if (sig) lines.push(`参数 schema: ${sig}`);
  return lines.join("\n");
}
