// 架构参考: Claude Code settings 分层合并(user → project → local → env/CLI):
//   1. 用户级  ~/.agent-harness/settings.json(env AGENT_HARNESS_HOME 可重定向) — 跨项目偏好
//   2. 项目级  <root>/demo/settings.json — 项目共享(本仓库既有约定, 零迁移)
//   3. 本地级  <root>/.agent-harness/settings.json — 个人本地覆盖(gitignored, 对标 settings.local.json)
//   env/CLI(ANTHROPIC_MODEL / chat --append-system-prompt)最高, 由消费方经 resolveModel/composeSystemPrompt 解析。
// 合并语义: permissions 并集 / hooks 按事件连接 / mcpServers 按键整体覆盖 / engine+model 标量深层覆盖 /
//   systemPromptAppend 字符串拼接(user → project → local)。
// 坏配置字段级降级: 字段类型错 → 忽略该字段 + 详细警告(其余字段照常); 仅 JSON 解析失败/根非 object 才整层跳过; 不 throw。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PermissionRules } from "../permissions/rules";
import { HookSettings, parseHookSettings } from "../hooks/events";
import { McpServerConfig } from "../mcp/client";

// 单层原始形态(JSON.parse 结果; 类型为声明意图, 运行时仍逐字段校验 — 配置边界不可信)
export interface RawSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: unknown; // 事件名 → HookConfig[](形态由 parseHookSettings 收敛)
  mcpServers?: Record<string, McpServerConfig>;
  engine?: { maxTurns?: number; tokenBudget?: number };
  model?: string;
  systemPromptAppend?: string;
}

// 分层诊断: 三层加载状态 + 字段级降级警告(热加载与测试均据此观测)
export interface LayerReport {
  path: string;
  loaded: boolean; // 文件存在且解析为 JSON object
  warnings: string[];
}

export interface MergedSettings {
  rules: PermissionRules;
  hookSettings: HookSettings;
  mcpServers: Record<string, McpServerConfig>;
  engine: { maxTurns?: number; tokenBudget?: number };
  model?: string;
  systemPromptAppend: string; // 各层拼接结果(user → project → local)
  layers: LayerReport[];
}

// 三层路径: 数组序即合并序(user 最浅, local 最深 — 深层覆盖浅层)
export function resolveLayerPaths(opts?: { userDir?: string; projectRoot?: string }): string[] {
  const projectRoot = opts?.projectRoot ?? process.cwd();
  const userDir = opts?.userDir ?? process.env.AGENT_HARNESS_HOME ?? path.join(os.homedir(), ".agent-harness");
  return [
    path.join(userDir, "settings.json"),
    path.join(projectRoot, "demo", "settings.json"),
    path.join(projectRoot, ".agent-harness", "settings.json"),
  ];
}

// model 解析序: env ANTHROPIC_MODEL(显式最高) > settings(深层覆盖已在 mergeSettings 折叠) > 内置默认
export function resolveModel(merged: Pick<MergedSettings, "model">): string {
  return process.env.ANTHROPIC_MODEL ?? merged.model ?? "claude-sonnet-4-5";
}

// 系统提示组装: 内置基线 → settings 追加段(user → project → local) → CLI 追加 → 模式后缀。
// 模式后缀(Plan 等)由引擎注入, 永远最后且不可被配置覆盖。
export function composeSystemPrompt(
  base: string,
  merged: Pick<MergedSettings, "systemPromptAppend">,
  extra?: { cliAppend?: string; modeSuffix?: string }
): string {
  return [base, merged.systemPromptAppend || undefined, extra?.cliAppend || undefined, extra?.modeSuffix || undefined]
    .filter((s): s is string => !!s)
    .join("\n\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

const KNOWN_FIELDS = new Set(["permissions", "hooks", "mcpServers", "engine", "model", "systemPromptAppend"]);

// 纯合并(单测入口, 无 IO): 逐层折叠, 字段级降级警告归属到层报告
export function mergeSettings(layers: { path: string; raw: RawSettings }[]): MergedSettings {
  const rules: PermissionRules = { allow: [], deny: [], ask: [] };
  const hookRaw: Record<string, unknown[]> = {}; // 事件名 → 跨层连接的原始数组
  const mcpServers: Record<string, McpServerConfig> = {};
  const engine: { maxTurns?: number; tokenBudget?: number } = {};
  let model: string | undefined;
  const appends: string[] = [];
  const reports: LayerReport[] = [];

  for (const { path: layerPath, raw } of layers) {
    const warnings: string[] = [];
    const src = raw as Record<string, unknown>;

    // 未知顶层字段: 前向兼容不拒绝, 仅提示(帮助拼写错误早暴露)
    const unknown = Object.keys(src).filter((k) => !KNOWN_FIELDS.has(k));
    if (unknown.length > 0) warnings.push(`未知字段(已忽略): ${unknown.join(", ")}`);

    // permissions: 子字段级降级 — 坏 allow 不影响同层 deny; 瀑布序保证 deny 跨层压过 allow
    const perms = src.permissions;
    if (perms !== undefined) {
      if (isPlainObject(perms)) {
        for (const key of ["allow", "deny", "ask"] as const) {
          const v = perms[key];
          if (v === undefined) continue;
          if (isStringArray(v)) rules[key].push(...v);
          else warnings.push(`permissions.${key}: 期望 string[], 实际 ${typeName(v)}(已忽略)`);
        }
      } else {
        warnings.push(`permissions: 期望 object, 实际 ${typeName(perms)}(整段已忽略)`);
      }
    }

    // hooks: 按事件键连接数组(user 先注册先执行 → project → local); 条目形态由 parseHookSettings 收敛
    const hooks = src.hooks;
    if (hooks !== undefined) {
      if (isPlainObject(hooks)) {
        for (const [event, v] of Object.entries(hooks)) {
          if (Array.isArray(v)) hookRaw[event] = [...(hookRaw[event] ?? []), ...v];
          else warnings.push(`hooks.${event}: 期望 array, 实际 ${typeName(v)}(已忽略)`);
        }
      } else {
        warnings.push(`hooks: 期望 object, 实际 ${typeName(hooks)}(整段已忽略)`);
      }
    }

    // mcpServers: 按键整体覆盖(server def 为原子配置单元); 值非 object 的键忽略
    const mcp = src.mcpServers;
    if (mcp !== undefined) {
      if (isPlainObject(mcp)) {
        for (const [name, def] of Object.entries(mcp)) {
          if (isPlainObject(def)) mcpServers[name] = def as unknown as McpServerConfig;
          else warnings.push(`mcpServers.${name}: 期望 object, 实际 ${typeName(def)}(已忽略)`);
        }
      } else {
        warnings.push(`mcpServers: 期望 object, 实际 ${typeName(mcp)}(整段已忽略)`);
      }
    }

    // engine: 标量深层覆盖(undefined 不覆盖); 数值须为正有限数
    const eng = src.engine;
    if (eng !== undefined) {
      if (isPlainObject(eng)) {
        for (const key of ["maxTurns", "tokenBudget"] as const) {
          const v = eng[key];
          if (v === undefined) continue;
          if (isPositiveNumber(v)) engine[key] = v;
          else warnings.push(`engine.${key}: 期望正数, 实际 ${typeof v === "number" ? v : typeName(v)}(已忽略)`);
        }
      } else {
        warnings.push(`engine: 期望 object, 实际 ${typeName(eng)}(整段已忽略)`);
      }
    }

    // model: 非空字符串
    const m = src.model;
    if (m !== undefined) {
      if (typeof m === "string" && m.length > 0) model = m;
      else warnings.push(`model: 期望非空 string, 实际 ${typeName(m)}(已忽略)`);
    }

    // systemPromptAppend: 非空字符串拼接(空串视为缺省, 不警告)
    const ap = src.systemPromptAppend;
    if (ap !== undefined) {
      if (typeof ap === "string") {
        if (ap.trim().length > 0) appends.push(ap);
      } else {
        warnings.push(`systemPromptAppend: 期望 string, 实际 ${typeName(ap)}(已忽略)`);
      }
    }

    reports.push({ path: layerPath, loaded: true, warnings });
  }

  return {
    rules,
    hookSettings: parseHookSettings(hookRaw),
    mcpServers,
    engine,
    model,
    systemPromptAppend: appends.join("\n\n"),
    layers: reports,
  };
}

// 入口: 三层路径 → 读文件(缺失=正常形态静默跳过; JSON 坏/根非 object=整层跳过+警告)→ 纯合并 → 警告经 log 外发
export function loadMergedSettings(
  opts?: { userDir?: string; projectRoot?: string; log?: (line: string) => void }
): MergedSettings {
  const log = opts?.log ?? console.log;
  const paths = resolveLayerPaths(opts);
  const layerInputs: { path: string; raw: RawSettings }[] = [];
  const broken = new Map<string, LayerReport>();
  let loadedCount = 0;

  for (const p of paths) {
    if (!fs.existsSync(p)) continue; // 缺失 = 最常见形态, 静默
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      broken.set(p, { path: p, loaded: false, warnings: [`JSON 解析失败, 整层跳过: ${(e as Error).message}`] });
      continue;
    }
    if (!isPlainObject(raw)) {
      broken.set(p, { path: p, loaded: false, warnings: [`根节点非 JSON object(${typeName(raw)}), 整层跳过`] });
      continue;
    }
    layerInputs.push({ path: p, raw: raw as RawSettings });
    loadedCount++;
  }

  const merged = mergeSettings(layerInputs);
  // 层报告补全为路径序: 缺失层(loaded:false 无警告)与坏层(带警告)均可见
  const loadedByPath = new Map(merged.layers.map((r) => [r.path, r]));
  merged.layers = paths.map((p) => loadedByPath.get(p) ?? broken.get(p) ?? { path: p, loaded: false, warnings: [] });

  if (loadedCount === 0) {
    log(`[settings] 未发现任何 settings 文件, 使用内置默认。查找路径: ${paths.join(" | ")}`);
  }
  for (const r of merged.layers) {
    for (const w of r.warnings) log(`[settings] ${r.path}: ${w}`);
  }
  return merged;
}
