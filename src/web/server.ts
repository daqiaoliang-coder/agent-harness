// Web 模式: 零依赖(http + SSE) — 引擎与浏览器的桥接层。
//   GET  /                      → 单页前端(demo/web/index.html)
//   GET  /api/events            → SSE 事件流(ready/history + 实时 UiEvent, 全部带 sessionId 标记)
//   GET  /api/sessions          → 会话列表(transcript *.jsonl)
//   GET  /api/session/history   → 指定活动会话回放(?sessionId= → 消息树事件 + 挂起弹窗 + running 态)
//   GET  /api/stats             → 错误遥测汇总(错误分类计数 + 活动会话轮次/token 用量)
//   POST /api/message           → 发送用户消息({text, sessionId?}; 每会话独立串行队列 → 跨会话并发)
//   POST /api/permission/:id    → 权限弹窗应答(resolve 挂起的 userResponder Promise)
//   POST /api/abort             → 中断指定会话当前运行({sessionId?}; 仅冲洗目标会话的挂起弹窗)
//   POST /api/session/new       → 新会话 | POST /api/session/resume {sessionId} → 恢复(已在活动表则仅切换)
// 多会话模型: Map<sessionId, Live>(激活即移尾 = LRU; 上限 8, 超限驱逐最旧 — close+冲洗弹窗, transcript 保留可再 resume)。
//   每会话独立 sendChain(会话内串行, 跨会话并发)与独立 AbortController;
//   SSE 事件按 sessionId 标记广播, 前端按当前视图过滤 → 多标签页可各自查看不同会话。
// 鉴权: 启动生成随机 token(AUTH_TOKEN 环境变量可固定), 所有端点校验
//   (header x-auth-token 或 query ?token=; SSE 用 query — EventSource 不能设 header);
//   默认绑定 127.0.0.1(HOST 环境变量可改), 防止局域网未授权访问/替答权限弹窗
// Provider: resolveApiKey()(env > macOS Keychain, 见 credentials/keychain.ts) → 真实(auto 模式);
//   否则 mock(default 模式, 未命中规则的命令落到用户弹窗可演示权限 UI)
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { LLMProvider, MockProvider, ScriptedTurn } from "../llm/provider";
import { AnthropicProvider } from "../llm/anthropicProvider";
import { EventBus, UiEvent, historyFromMessages } from "../events";
import { PermissionAsk, PermissionMode } from "../permissions/engine";
import { resolveApiKey } from "../credentials/keychain";
import { getTelemetry } from "../telemetry/telemetry";
import {
  createSession,
  loadSettings,
  SESSIONS_DIR,
  PROJECT_ROOT,
  CHAT_SYSTEM_PROMPT,
  Session,
} from "../cli";
import { PRODUCTION_COMPACT_CONFIG, computeWatermarks } from "../compact/watermarks";

const PORT = Number(process.env.PORT ?? 3218);
// 默认只绑定回环地址: 未鉴权的局域网暴露 = 任何人可发消息/替答权限弹窗(= 远程授权任意 Bash)
const HOST = process.env.HOST ?? "127.0.0.1";
const INDEX_HTML = path.join(PROJECT_ROOT, "demo", "web", "index.html");
// 鉴权 token: AUTH_TOKEN 环境变量固定(测试/脚本友好); 否则每次启动随机生成
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? crypto.randomBytes(24).toString("base64url");
// 活动会话上限(LRU 驱逐): 每个会话持有独立 MCP 子进程与消息树, 无限累积会耗尽资源
const MAX_LIVE_SESSIONS = 8;

// mock 脚本: ls 走只读白名单直接执行; date 不在白名单 → default 模式落到用户弹窗(演示权限 UI);
// 第 3 条消息触发必然失败的工具(非零退出) → 遥测 toolErrors 计数(GET /api/stats 可见)
const WEB_MOCK_SCRIPT: ScriptedTurn[] = [
  { toolUses: [{ name: "Bash", input: { command: "ls -la" } }] },
  { toolUses: [{ name: "Bash", input: { command: "date" } }] },
  {
    text:
      "目录与时间已查看(mock 脚本)。当前为 mock 模式 — 未检测到 API key(env/Keychain); " +
      "配置后重启服务即可切换真实模型(auto 权限模式)。",
  },
  { toolUses: [{ name: "Bash", input: { command: "ls /definitely-not-exist-xyz" } }] },
  { text: "第 4 轮工具按预期失败(mock 演示): 该结果计入遥测 toolErrors(GET /api/stats)。" },
];

const bus = new EventBus();

// ── 活动会话表(多会话并发核心): Map 迭代序 = LRU 序(激活即移尾) ──
interface Live {
  id: string;
  session: Session;
  meta: { model: string; mode: PermissionMode; provider: string };
  sendChain: Promise<void>; // 会话内消息串行(对照 CLI readline 行级串行); 跨会话互不阻塞
  running: boolean; // 是否有 send 在飞(切换会话时前端据此恢复 停止按钮/输入框 状态)
}
const liveSessions = new Map<string, Live>();
let lastActiveId: string | null = null; // 最近激活的会话(不带 sessionId 的请求默认目标, 兼容旧客户端)
let webSessSeq = 0;

// SSE 事件标记: 所有事件带 sessionId → 前端按当前视图过滤(多标签页各看各的会话)
type TaggedEvent = UiEvent & { sessionId: string };
function tagged(sessionId: string, e: UiEvent): TaggedEvent {
  return { ...e, sessionId } as TaggedEvent;
}

// ── 权限弹窗桥接: userResponder → permission_request 事件 → HTTP 应答 → resolve ──
// 挂起请求保存完整事件(带 sessionId)→ SSE 重连/页面刷新时补放(否则弹窗丢失, 引擎永久挂起)
interface PendingPerm {
  sessionId: string;
  resolve: (answer: "yes" | "no") => void;
  req: Extract<UiEvent, { kind: "permission_request" }>;
}
// 全局表(perm id 全局唯一), 冲洗按会话过滤 → abort/驱逐只影响目标会话
const pendingPerms = new Map<string, PendingPerm>();
let permSeq = 0;
const makeUserResponder = (sessionId: string) => (ask: PermissionAsk) =>
  new Promise<"yes" | "no">((resolve) => {
    const id = `perm_${++permSeq}`;
    const req = { kind: "permission_request" as const, id, toolName: ask.toolName, reason: ask.why, input: ask.toolInput };
    pendingPerms.set(id, { sessionId, resolve, req });
    bus.emit(tagged(sessionId, req));
  });

// 冲洗指定会话的挂起权限弹窗(中断/驱逐): 全部视作拒绝 + 通知前端关弹窗(其他会话不受影响)
function flushSessionPerms(sessionId: string): void {
  for (const [id, p] of pendingPerms) {
    if (p.sessionId !== sessionId) continue;
    pendingPerms.delete(id);
    p.resolve("no");
    bus.emit(tagged(sessionId, { kind: "permission_resolved", id, answer: "no" }));
  }
}

// LRU 驱逐: 活动会话超上限 → 关闭最旧(close: 停 MCP + 取消设置监听; transcript 保留可再 resume)
function evictOverflow(): void {
  while (liveSessions.size > MAX_LIVE_SESSIONS) {
    const oldest = liveSessions.keys().next().value;
    if (oldest === undefined || oldest === lastActiveId) break; // 最近活动会话必在 Map 尾, 不会到这里
    const live = liveSessions.get(oldest)!;
    liveSessions.delete(oldest);
    flushSessionPerms(oldest);
    live.session.close();
    console.log(`[web] 活动会话超上限(${MAX_LIVE_SESSIONS}) → 驱逐最旧: ${oldest}(transcript 保留, 可再 resume)`);
  }
}

// ── 消息入队(每会话独立串行链; 同一时刻每会话只跑一个 send) ──
function enqueueSend(live: Live, text: string): void {
  live.running = true;
  live.sendChain = live.sendChain
    .then(async () => {
      await live.session.send(text);
    })
    .catch((e: Error) => {
      bus.emit(tagged(live.id, { kind: "error", text: e.message }));
      bus.emit(tagged(live.id, { kind: "stop" })); // 前端复位流式气泡
    })
    .finally(() => {
      live.running = false;
    });
}

// ── 会话初始化/切换 ──
function makeProvider(): { provider: LLMProvider; model: string; mode: PermissionMode; providerName: string } {
  const resolved = resolveApiKey();
  if (resolved) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    console.log(`[web] API key 来源: ${resolved.source === "env" ? "环境变量" : "macOS Keychain"} → 真实模型 ${model}`);
    return {
      provider: new AnthropicProvider({ apiKey: resolved.apiKey, model, log: (l) => console.log(l) }),
      model,
      mode: "auto",
      providerName: `anthropic:${model}`,
    };
  }
  console.log("[web] 未检测到 API key(env/Keychain) → mock 模式(default 权限模式, 可演示权限弹窗)");
  return { provider: new MockProvider(WEB_MOCK_SCRIPT), model: "mock", mode: "default", providerName: "mock" };
}

function broadcastReady(live: Live): void {
  bus.emit(tagged(live.id, {
    kind: "ready",
    sessionId: live.id,
    model: live.meta.model,
    mode: live.meta.mode,
    provider: live.meta.provider,
  }));
  bus.emit(tagged(live.id, { kind: "history", events: historyFromMessages(live.session.state.messages) }));
}

// 激活会话: 已在活动表 → 仅切换(并发状态完整保留, 不重建 provider/不清消息树);
// 否则新建(resumeId 有值 = 从 transcript 恢复)。返回 sessionId。
async function activateSession(opts: { resumeId?: string } = {}): Promise<string> {
  if (opts.resumeId && liveSessions.has(opts.resumeId)) {
    const live = liveSessions.get(opts.resumeId)!;
    liveSessions.delete(opts.resumeId);
    liveSessions.set(opts.resumeId, live); // 移尾 = LRU 最近使用
    lastActiveId = opts.resumeId;
    broadcastReady(live);
    return lastActiveId;
  }
  const { rules, hookSettings, mcpServers, engine } = loadSettings();
  const p = makeProvider();
  const sessionId = opts.resumeId ?? `sess_web_${Date.now()}_${++webSessSeq}`;
  const emit = (e: UiEvent) => bus.emit(tagged(sessionId, e));
  const session = await createSession({
    provider: p.provider,
    cfg: PRODUCTION_COMPACT_CONFIG,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    rules,
    hookSettings,
    mcpServers,
    engine,
    sessionId,
    mode: p.mode,
    resume: opts.resumeId !== undefined,
    renderDelta: (t) => emit({ kind: "assistant_delta", text: t }),
    emit,
    logFn: (line) => {
      if (line !== "") emit({ kind: "log", text: line }); // 空行(排版用)不上事件流
    },
    userResponder: makeUserResponder(sessionId),
  });
  const live: Live = {
    id: sessionId,
    session,
    meta: { model: p.model, mode: p.mode, provider: p.providerName },
    sendChain: Promise.resolve(),
    running: false,
  };
  liveSessions.set(sessionId, live);
  lastActiveId = sessionId;
  evictOverflow();
  const wm = computeWatermarks(PRODUCTION_COMPACT_CONFIG);
  console.log(
    `[web] 会话就绪: ${sessionId} | provider=${p.providerName} | 权限模式=${p.mode} | ` +
      `effectiveWindow=${wm.effectiveWindow}${opts.resumeId ? " (resume)" : ""} | ` +
      `活动会话 ${liveSessions.size}/${MAX_LIVE_SESSIONS}`
  );
  broadcastReady(live);
  return sessionId;
}

// ── HTTP 基础设施 ──
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.length > 1_000_000) reject(new Error("请求体过大")); // 1MB 上限
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function listSessions(): Array<{ id: string; mtime: number }> {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

// 鉴权: header x-auth-token 或 query ?token= (SSE/EventSource 只能用 query)
function isAuthorized(req: http.IncomingMessage, query: URLSearchParams): boolean {
  const token = req.headers["x-auth-token"] ?? query.get("token") ?? "";
  return typeof token === "string" && token.length === AUTH_TOKEN.length && token === AUTH_TOKEN;
}

// 请求目标会话解析: 显式 sessionId > 最近活动会话(兼容不带 id 的旧客户端)
function targetSession(body: Record<string, unknown>): Live | { error: string; code: 404 | 409 } {
  const explicit = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
  const id = explicit ?? lastActiveId;
  const live = id ? liveSessions.get(id) : undefined;
  if (live) return live;
  return explicit
    ? { error: `会话未激活: ${explicit}`, code: 404 }
    : { error: "无活动会话", code: 409 };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const urlObj = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const url = urlObj.pathname;

  // 全端点鉴权(含静态页): token 错误/缺失 → 401
  if (!isAuthorized(req, urlObj.searchParams)) {
    if (url.startsWith("/api/")) {
      json(res, 401, { error: "未授权: 缺少或错误的 token(启动 URL 里的 ?token=, 或 header x-auth-token)" });
    } else {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("401 未授权 — 请使用启动时打印的带 token 的 URL 打开本页面");
    }
    return;
  }

  // SSE 事件流: 最近活动会话的 ready + history 开场, 之后实时转发(带 sessionId);
  // 挂起权限请求全部补放(带 sessionId, 前端按视图过滤 → 页面刷新后弹窗不丢失)
  if (req.method === "GET" && url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    if (lastActiveId) {
      const live = liveSessions.get(lastActiveId);
      if (live) {
        res.write(`data: ${JSON.stringify(tagged(live.id, {
          kind: "ready",
          sessionId: live.id,
          model: live.meta.model,
          mode: live.meta.mode,
          provider: live.meta.provider,
        }))}\n\n`);
        res.write(`data: ${JSON.stringify(tagged(live.id, { kind: "history", events: historyFromMessages(live.session.state.messages) }))}\n\n`);
      }
    }
    for (const p of pendingPerms.values()) {
      res.write(`data: ${JSON.stringify(tagged(p.sessionId, p.req))}\n\n`);
    }
    const off = bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const hb = setInterval(() => res.write(": hb\n\n"), 25_000); // 心跳防代理断连
    req.on("close", () => {
      clearInterval(hb);
      off();
    });
    return;
  }

  if (req.method === "GET" && url === "/") {
    if (!fs.existsSync(INDEX_HTML)) {
      res.writeHead(500).end("未找到 demo/web/index.html — 请在仓库根目录运行");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(INDEX_HTML));
    return;
  }

  if (req.method === "GET" && url === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && url === "/api/sessions") {
    json(res, 200, { sessions: listSessions() });
    return;
  }

  // 指定活动会话回放: 前端切换会话时显式拉取(确定性时序, 不依赖 SSE 广播竞态);
  // 附挂起弹窗与 running 态(切到运行中的会话 → 停止按钮正确恢复)
  if (req.method === "GET" && url === "/api/session/history") {
    const id = urlObj.searchParams.get("sessionId") ?? "";
    const live = liveSessions.get(id);
    if (!live) {
      return json(res, 404, { error: `会话未激活: ${id || "(空)"}(先 POST /api/session/resume)` });
    }
    return json(res, 200, {
      sessionId: id,
      model: live.meta.model,
      mode: live.meta.mode,
      provider: live.meta.provider,
      running: live.running,
      events: historyFromMessages(live.session.state.messages),
      pendingPerms: [...pendingPerms.values()].filter((p) => p.sessionId === id).map((p) => tagged(id, p.req)),
    });
  }

  // 遥测汇总: 错误分类计数(引擎级 JSONL 落盘 + 工具级计数) + 活动会话轮次/token 用量
  if (req.method === "GET" && url === "/api/stats") {
    const t = getTelemetry(PROJECT_ROOT);
    return json(res, 200, {
      since: t.since,
      errors: t.errorStats,
      sessions: { live: liveSessions.size, recorded: listSessions().length },
      liveSessions: [...liveSessions.values()].map((l) => ({
        id: l.id,
        model: l.meta.model,
        mode: l.meta.mode,
        provider: l.meta.provider,
        running: l.running,
        turns: l.session.state.turnCount,
        tokensUsed: l.session.state.totalTokensUsed,
        errors: t.sessionErrorCount(l.id),
      })),
      logFile: t.logFile,
    });
  }

  if (req.method === "POST" && url === "/api/message") {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(res, 400, { error: "text 不能为空" });
    const target = targetSession(body);
    if ("error" in target) return json(res, target.code, { error: target.error });
    bus.emit(tagged(target.id, { kind: "user_message", text })); // 用户消息事件(引擎只写 transcript, 不回发)
    enqueueSend(target, text);
    return json(res, 200, { ok: true, sessionId: target.id });
  }

  const permMatch = url.match(/^\/api\/permission\/([\w.:-]+)$/);
  if (req.method === "POST" && permMatch) {
    const id = permMatch[1];
    const pending = pendingPerms.get(id);
    if (!pending) return json(res, 404, { error: "无此权限请求(可能已应答)" });
    const body = await readBody(req);
    const answer = body.answer === "yes" ? "yes" : "no";
    pendingPerms.delete(id);
    pending.resolve(answer);
    bus.emit(tagged(pending.sessionId, { kind: "permission_resolved", id, answer }));
    return json(res, 200, { ok: true });
  }

  // 中断指定会话的当前运行: LLM 请求/工具执行/压缩侧查询同轮中止(引擎保证消息树一致);
  // 仅目标会话的挂起权限弹窗被冲洗(其他会话不受影响)
  if (req.method === "POST" && url === "/api/abort") {
    const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
    const target = targetSession(body);
    if ("error" in target) return json(res, target.code, { error: target.error });
    const running = target.running;
    flushSessionPerms(target.id);
    target.session.abort();
    return json(res, 200, { ok: true, running, sessionId: target.id });
  }

  if (req.method === "POST" && url === "/api/session/new") {
    const sessionId = await activateSession();
    return json(res, 200, { ok: true, sessionId });
  }

  if (req.method === "POST" && url === "/api/session/resume") {
    const body = await readBody(req);
    const id = typeof body.sessionId === "string" ? body.sessionId.replace(/\.jsonl$/, "") : "";
    if (!id || !fs.existsSync(path.join(SESSIONS_DIR, `${id}.jsonl`))) {
      return json(res, 404, { error: `会话不存在: ${id}` });
    }
    const sessionId = await activateSession({ resumeId: id });
    return json(res, 200, { ok: true, sessionId });
  }

  json(res, 404, { error: `未路由: ${req.method} ${url}` });
}

export async function runWeb(): Promise<void> {
  await activateSession(); // 启动即建会话(浏览器打开即可聊)
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  const resolved = resolveApiKey();
  const providerHint = resolved
    ? `真实模型 ${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"}(key 来源: ${resolved.source === "env" ? "env" : "Keychain"})`
    : "mock 模式(无 API key; node dist/cli.js key set 可存入 Keychain)";
  const tokenHint = process.env.AUTH_TOKEN ? "(AUTH_TOKEN 环境变量)" : "(每次启动随机生成)";
  console.log(`═══ agent-harness web ═══`);
  console.log(`[web] 地址: http://${HOST}:${PORT}/?token=${AUTH_TOKEN}`);
  console.log(`[web] 鉴权 token${tokenHint}: 所有端点(含 SSE/静态页)必须携带; HOST 绑定 ${HOST}`);
  console.log(`[web] ${providerHint} | 多会话并发(上限 ${MAX_LIVE_SESSIONS}) | 依赖沿用 demo/settings.json; 引擎与 chat 模式完全共享`);
}
