// Web 模式: 零依赖(http + SSE) — 引擎与浏览器的桥接层。
//   GET  /                  → 单页前端(demo/web/index.html)
//   GET  /api/events        → SSE 事件流(ready/history + 实时 UiEvent)
//   GET  /api/sessions      → 会话列表(transcript *.jsonl)
//   POST /api/message       → 发送用户消息(串行队列; 结果走 SSE)
//   POST /api/permission/:id→ 权限弹窗应答(resolve 挂起的 userResponder Promise)
//   POST /api/session/new   → 新会话 | POST /api/session/resume {sessionId} → 恢复
// Provider: 有 ANTHROPIC_API_KEY → 真实(auto 模式); 否则 mock(default 模式, 未命中规则的命令落到用户弹窗可演示权限 UI)
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { LLMProvider, MockProvider, ScriptedTurn } from "../llm/provider";
import { AnthropicProvider } from "../llm/anthropicProvider";
import { EventBus, UiEvent, historyFromMessages } from "../events";
import { PermissionAsk, PermissionMode } from "../permissions/engine";
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
const INDEX_HTML = path.join(PROJECT_ROOT, "demo", "web", "index.html");

// mock 脚本: ls 走只读白名单直接执行; date 不在白名单 → default 模式落到用户弹窗(演示权限 UI)
const WEB_MOCK_SCRIPT: ScriptedTurn[] = [
  { toolUses: [{ name: "Bash", input: { command: "ls -la" } }] },
  { toolUses: [{ name: "Bash", input: { command: "date" } }] },
  {
    text:
      "目录与时间已查看(mock 脚本)。当前为 mock 模式 — 未检测到 ANTHROPIC_API_KEY; " +
      "配置 key 后重启服务即可切换真实模型(auto 权限模式)。",
  },
];

const bus = new EventBus();

// ── 活动会话(单会话模型: 切换 = close 旧的 + createSession 新的) ──
let session: Session | null = null;
let meta = { model: "mock", mode: "default" as PermissionMode, provider: "mock" };

// ── 权限弹窗桥接: userResponder → permission_request 事件 → HTTP 应答 → resolve ──
// 挂起请求保存完整事件 → SSE 重连/页面刷新时补放(否则弹窗丢失, 引擎永久挂起)
interface PendingPerm {
  resolve: (answer: "yes" | "no") => void;
  req: Extract<UiEvent, { kind: "permission_request" }>;
}
const pendingPerms = new Map<string, PendingPerm>();
let permSeq = 0;
const userResponder = (ask: PermissionAsk) =>
  new Promise<"yes" | "no">((resolve) => {
    const id = `perm_${++permSeq}`;
    const req = { kind: "permission_request" as const, id, toolName: ask.toolName, reason: ask.why, input: ask.toolInput };
    pendingPerms.set(id, { resolve, req });
    bus.emit(req);
  });

// ── 消息串行队列(同一时刻只跑一个 send, 对照 CLI readline 的行级串行) ──
let sendChain: Promise<void> = Promise.resolve();
function enqueueSend(text: string): void {
  sendChain = sendChain
    .then(async () => {
      if (!session) throw new Error("无活动会话");
      await session.send(text);
    })
    .catch((e: Error) => {
      bus.emit({ kind: "error", text: e.message });
      bus.emit({ kind: "stop" }); // 前端复位流式气泡
    });
}

// ── 会话初始化/切换 ──
function makeProvider(): { provider: LLMProvider; model: string; mode: PermissionMode; providerName: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    return {
      provider: new AnthropicProvider({ model, log: (l) => console.log(l) }),
      model,
      mode: "auto",
      providerName: `anthropic:${model}`,
    };
  }
  console.log("[web] 未检测到 ANTHROPIC_API_KEY → mock 模式(default 权限模式, 可演示权限弹窗)");
  return { provider: new MockProvider(WEB_MOCK_SCRIPT), model: "mock", mode: "default", providerName: "mock" };
}

async function initSession(opts: { resumeId?: string } = {}): Promise<void> {
  session?.close(); // 切换: 停 MCP 子进程 + 取消设置监听
  const { rules, hookSettings, mcpServers } = loadSettings();
  const p = makeProvider();
  const sessionId = opts.resumeId ?? `sess_web_${Date.now()}`;
  meta = { model: p.model, mode: p.mode, provider: p.providerName };
  session = await createSession({
    provider: p.provider,
    cfg: PRODUCTION_COMPACT_CONFIG,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    rules,
    hookSettings,
    mcpServers,
    sessionId,
    mode: p.mode,
    resume: opts.resumeId !== undefined,
    renderDelta: (t) => bus.emit({ kind: "assistant_delta", text: t }),
    emit: (e) => bus.emit(e),
    logFn: (line) => {
      if (line !== "") bus.emit({ kind: "log", text: line }); // 空行(排版用)不上事件流
    },
    userResponder,
  });
  const wm = computeWatermarks(PRODUCTION_COMPACT_CONFIG);
  console.log(
    `[web] 会话就绪: ${sessionId} | provider=${p.providerName} | 权限模式=${p.mode} | ` +
      `effectiveWindow=${wm.effectiveWindow}${opts.resumeId ? " (resume)" : ""}`
  );
  // 广播给已连接的 SSE 客户端(新连接的客户端在连接时单独发)
  broadcastReady();
}

function broadcastReady(): void {
  if (!session) return;
  bus.emit({
    kind: "ready",
    sessionId: path.basename(session.transcriptPath, ".jsonl"),
    model: meta.model,
    mode: meta.mode,
    provider: meta.provider,
  });
  bus.emit({ kind: "history", events: historyFromMessages(session.state.messages) });
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? "/").split("?")[0];

  // SSE 事件流: ready + history 开场, 之后实时转发
  if (req.method === "GET" && url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    if (session) {
      res.write(`data: ${JSON.stringify({
        kind: "ready",
        sessionId: path.basename(session.transcriptPath, ".jsonl"),
        model: meta.model,
        mode: meta.mode,
        provider: meta.provider,
      } as UiEvent)}\n\n`);
      res.write(`data: ${JSON.stringify({ kind: "history", events: historyFromMessages(session.state.messages) } as UiEvent)}\n\n`);
      // 补放挂起中的权限请求(页面刷新/SSE 重连后弹窗不丢失)
      for (const p of pendingPerms.values()) {
        res.write(`data: ${JSON.stringify(p.req)}\n\n`);
      }
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

  if (req.method === "POST" && url === "/api/message") {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(res, 400, { error: "text 不能为空" });
    if (!session) return json(res, 409, { error: "无活动会话" });
    bus.emit({ kind: "user_message", text }); // 用户消息事件(引擎只写 transcript, 不回发)
    enqueueSend(text);
    return json(res, 200, { ok: true });
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
    bus.emit({ kind: "permission_resolved", id, answer });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/api/session/new") {
    await initSession();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/api/session/resume") {
    const body = await readBody(req);
    const id = typeof body.sessionId === "string" ? body.sessionId.replace(/\.jsonl$/, "") : "";
    if (!id || !fs.existsSync(path.join(SESSIONS_DIR, `${id}.jsonl`))) {
      return json(res, 404, { error: `会话不存在: ${id}` });
    }
    await initSession({ resumeId: id });
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: `未路由: ${req.method} ${url}` });
}

export async function runWeb(): Promise<void> {
  await initSession(); // 启动即建会话(浏览器打开即可聊)
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  const providerHint = process.env.ANTHROPIC_API_KEY
    ? `真实模型 ${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"}`
    : "mock 模式(无 ANTHROPIC_API_KEY)";
  console.log(`═══ agent-harness web ═══`);
  console.log(`[web] http://localhost:${PORT} | ${providerHint}`);
  console.log(`[web] 依赖沿用 demo/settings.json(规则/Hook/MCP); 引擎与 chat 模式完全共享`);
}
