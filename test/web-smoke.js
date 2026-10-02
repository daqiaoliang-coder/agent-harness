// test/web-smoke.js — Web 模式冒烟测试(mock provider, 无需 API key)
// 覆盖: 鉴权(无/错 token → 401, 全端点含静态页/SSE) / 静态页 / SSE 事件流(ready/history) /
//       消息发送 → 工具卡片事件(ls 白名单放行) / 权限弹窗桥接(date 未命中规则 → 弹窗 → HTTP 应答) /
//       SSE 重连补放挂起弹窗 / stop 收尾 / 会话列表 / 新建会话 /
//       中断 e2e(权限等待中 POST /api/abort → 弹窗拒绝 + aborted + transcript 树一致 + 会话可继续) /
//       多会话并发(A 挂起弹窗不阻塞 B; 事件带 sessionId 标记; abort 按会话隔离) /
//       会话历史端点 / 活动会话重复 resume 不重置 / 遥测汇总(GET /api/stats) /
//       会话级"总是允许" e2e(弹窗 alwaysRule → always 应答 → 同会话免弹窗 / 新会话不继承) /
//       工具输入校验 e2e(坏输入不弹窗直接 error tool_result) /
//       分层配置 e2e(独立 spawn + 用户级 allow 规则跨层生效, date 免弹窗) /
//       slash 命令 + 模式运行中切换 e2e(独立 spawn: /mode 命令拦截 + plan 门禁 + /api/mode 下拉路径 + bypass 双确认) /
//       用量仪表盘 e2e(独立 spawn: 每轮 usage 事件水位快照 + GET /api/usage 5h 窗口聚合 + /usage 命令回流)
// 用法: npm run build && node test/web-smoke.js
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..");
const TOKEN = "test-token-123"; // AUTH_TOKEN 环境变量固定 → 测试确定性

// token=null 不带 header(测 401); 其他值带 x-auth-token; base 供测试 18 的独立实例复用
function fetchJson(method, url, body, token = TOKEN, base = BASE) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (token !== null) headers["x-auth-token"] = token;
    const req = http.request(`${base}${url}`, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// SSE 客户端: 收集事件, 提供 waitFor 谓词(token 走 query — EventSource 不能设 header)
// waitFor(pred, timeout, after): after = 事件快照下标, 只匹配此后到达的事件
//   (默认 0 = 全历史; 二次发消息的用例必须传快照, 否则会命中上一轮的旧事件)
function sseCollect(token = TOKEN, base = BASE) {
  const events = [];
  const waiters = [];
  const req = http.get(`${base}/api/events?token=${encodeURIComponent(token)}`, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c.toString();
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue; // 心跳/注释帧
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        const evIdx = events.length - 1;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i](ev, evIdx)) waiters.splice(i, 1);
        }
      }
    });
  });
  return {
    events,
    waitFor(pred, timeoutMs = 15000, after = 0) {
      for (let i = after; i < events.length; i++) {
        if (pred(events[i])) return Promise.resolve(events[i]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("waitFor 超时")), timeoutMs);
        waiters.push((ev, idx) => {
          if (idx >= after && pred(ev)) {
            clearTimeout(timer);
            resolve(ev);
            return true;
          }
          return false;
        });
      });
    },
    close: () => req.destroy(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── 启动服务器(mock 模式: 清空 ANTHROPIC_API_KEY; AUTH_TOKEN 固定;
  //    AGENT_HARNESS_NO_KEYCHAIN=1 防止读到开发者真实 Keychain key 导致 mock 模式失效;
  //    AGENT_HARNESS_HOME 指向空临时目录 → 用户级 settings 层封闭, 不受开发机 ~/.agent-harness 影响) ──
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "web-smoke-home-"));
  const server = spawn("node", ["dist/cli.js", "web"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      PORT: String(PORT),
      AUTH_TOKEN: TOKEN,
      AGENT_HARNESS_NO_KEYCHAIN: "1",
      AGENT_HARNESS_HOME: emptyHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (d) => (serverErr += d.toString()));
  const killServer = () => server.kill("SIGKILL");
  process.on("exit", killServer);

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    try {
      await fetchJson("GET", "/api/sessions");
      up = true;
    } catch { /* 等待启动 */ }
  }
  assert.ok(up, `服务器未启动\nstderr: ${serverErr}`);
  console.log("  ✓ 服务器启动(mock 模式)");

  let passed = 0;
  let sse = null;
  try {
    // 1. 鉴权: 无/错 token → 401(API / 静态页 / SSE 全端点)
    const noTok = await fetchJson("GET", "/api/sessions", undefined, null);
    assert.strictEqual(noTok.status, 401);
    const badTok = await fetchJson("GET", "/api/sessions", undefined, "wrong-token");
    assert.strictEqual(badTok.status, 401);
    const page401 = await new Promise((resolve, reject) => {
      http.get(`${BASE}/`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }).on("error", reject);
    });
    assert.strictEqual(page401.status, 401);
    assert.ok(page401.body.includes("token"), "401 页面应提示使用带 token 的 URL");
    const sse401 = await new Promise((resolve) => {
      http.get(`${BASE}/api/events`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
    });
    assert.strictEqual(sse401, 401);
    passed++; console.log("  ✓ 鉴权: 无/错 token → 401(API/静态页/SSE)");

    // 2. 静态页(带 token → 200)
    const page = await new Promise((resolve, reject) => {
      http.get(`${BASE}/`, { headers: { "x-auth-token": TOKEN } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }).on("error", reject);
    });
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes("agent-harness"), "首页应含 agent-harness");
    passed++; console.log("  ✓ 静态首页 200(token)");

    // 3. SSE: ready + history
    sse = sseCollect();
    await sse.waitFor((e) => e.kind === "ready");
    assert.ok(sse.events.some((e) => e.kind === "history"));
    passed++; console.log("  ✓ SSE ready/history 事件");

    // 4. 发消息 → mock 脚本: ls(白名单放行) → date(弹窗) → 文本 → stop
    const send1 = await fetchJson("POST", "/api/message", { text: "看下目录和时间" });
    assert.strictEqual(send1.status, 200);

    const lsStart = await sse.waitFor((e) => e.kind === "tool_start" && e.input.command === "ls -la");
    assert.strictEqual(lsStart.name, "Bash");
    await sse.waitFor((e) => e.kind === "perm" && e.decision === "allow" && e.source === "static");
    await sse.waitFor((e) => e.kind === "tool_result" && e.id === lsStart.id && !e.isError);
    passed++; console.log("  ✓ 工具卡片事件: tool_start/perm(白名单)/tool_result");

    // 5. 权限弹窗桥接: date 未命中规则 → permission_request → HTTP 应答 yes → 放行执行
    const dateStart = await sse.waitFor((e) => e.kind === "tool_start" && e.input.command === "date");
    const permReq = await sse.waitFor((e) => e.kind === "permission_request");
    assert.strictEqual(permReq.toolName, "Bash");
    assert.strictEqual(permReq.input.command, "date");
    // 5a. SSE 重连补放: 挂起中的权限请求必须重放给新连接(页面刷新后弹窗不丢失)
    const sse2 = sseCollect();
    const replayed = await sse2.waitFor((e) => e.kind === "permission_request" && e.id === permReq.id);
    assert.strictEqual(replayed.input.command, "date");
    sse2.close();
    passed++; console.log("  ✓ SSE 重连补放挂起权限请求");
    const answer = await fetchJson("POST", `/api/permission/${encodeURIComponent(permReq.id)}`, { answer: "yes" });
    assert.strictEqual(answer.status, 200);
    await sse.waitFor((e) => e.kind === "permission_resolved" && e.id === permReq.id && e.answer === "yes");
    await sse.waitFor((e) => e.kind === "perm" && e.source === "user" && e.decision === "allow");
    await sse.waitFor((e) => e.kind === "tool_result" && e.id === dateStart.id && !e.isError);
    passed++; console.log("  ✓ 权限弹窗: request → HTTP 应答 → user 放行 → 执行");

    // 6. 文本回复 + stop
    const msg = await sse.waitFor((e) => e.kind === "assistant_message");
    assert.ok(msg.text.includes("mock"), "回复应来自 mock 脚本");
    await sse.waitFor((e) => e.kind === "stop");
    passed++; console.log("  ✓ assistant_message + stop 收尾");

    // 7. 重复应答 → 404(幂等保护)
    const again = await fetchJson("POST", `/api/permission/${encodeURIComponent(permReq.id)}`, { answer: "no" });
    assert.strictEqual(again.status, 404);
    passed++; console.log("  ✓ 权限请求重复应答 → 404");

    // 8. 会话列表
    const sess = await fetchJson("GET", "/api/sessions");
    assert.ok(sess.body.sessions.some((s) => s.id.startsWith("sess_web_")));
    passed++; console.log("  ✓ 会话列表");

    // 9. 新建会话 → ready 重播(history 清空; mock 脚本重置)
    const mark9 = sse.events.length; // 快照: 只匹配新会话事件(否则命中旧 ready/history)
    const newSess = await fetchJson("POST", "/api/session/new");
    assert.strictEqual(newSess.status, 200);
    const ready2 = await sse.waitFor((e) => e.kind === "ready", 15000, mark9);
    assert.ok(ready2.sessionId.startsWith("sess_web_"));
    const hist2 = await sse.waitFor((e) => e.kind === "history", 15000, mark9);
    assert.strictEqual(hist2.events.length, 0, "新会话 history 应为空");
    passed++; console.log("  ✓ 新建会话 → ready + 空 history");

    // 10. 中断 e2e: 权限弹窗等待中 POST /api/abort → 弹窗拒绝 + aborted + stop
    const mark10 = sse.events.length; // 快照: 排除第一轮消息的旧 tool/perm 事件
    const send2 = await fetchJson("POST", "/api/message", { text: "看下目录和时间" });
    assert.strictEqual(send2.status, 200);
    const lsStart2 = await sse.waitFor((e) => e.kind === "tool_start" && e.input.command === "ls -la", 15000, mark10);
    await sse.waitFor((e) => e.kind === "tool_result" && e.id === lsStart2.id && !e.isError, 15000, mark10);
    const dateStart2 = await sse.waitFor((e) => e.kind === "tool_start" && e.input.command === "date", 15000, mark10);
    const permReq2 = await sse.waitFor((e) => e.kind === "permission_request" && e.input.command === "date", 15000, mark10);
    const abortRes = await fetchJson("POST", "/api/abort");
    assert.strictEqual(abortRes.status, 200);
    assert.strictEqual(abortRes.body.running, true);
    // 弹窗被冲洗为拒绝(浏览器可能已无人值守, 不得悬挂)
    await sse.waitFor((e) => e.kind === "permission_resolved" && e.id === permReq2.id && e.answer === "no", 15000, mark10);
    // date 不执行, 以 error tool_result 入树(消息树一致)
    await sse.waitFor((e) => e.kind === "tool_result" && e.id === dateStart2.id && e.isError, 15000, mark10);
    await sse.waitFor((e) => e.kind === "aborted", 15000, mark10);
    await sse.waitFor((e) => e.kind === "stop", 15000, mark10);
    passed++; console.log("  ✓ 中断 e2e: 权限等待中 abort → 弹窗拒绝 + error 结果入树 + aborted + stop");

    // 10a. transcript 树一致: 中断轮的 tool_use 必须有配对 tool_result
    const transcript = fs.readFileSync(
      path.join(ROOT, ".agent-harness", "sessions", `${ready2.sessionId}.jsonl`),
      "utf8"
    );
    const tree = transcript.trim().split("\n").map((l) => JSON.parse(l));
    const useIds = new Set();
    const resultIds = new Set();
    for (const m of tree) {
      for (const b of m.content) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.tool_use_id);
      }
    }
    for (const id of useIds) assert.ok(resultIds.has(id), `tool_use ${id} 缺配对 tool_result`);
    assert.ok(resultIds.has(dateStart2.id), "中断的 date 工具应有 error tool_result 入树");
    passed++; console.log("  ✓ 中断后 transcript 树一致(tool_use 全部有配对结果)");

    // 11. 中断后恢复: 会话仍可用(每条消息独立 AbortController; 本轮消费 mock 脚本 turn 2 文本)
    const mark11 = sse.events.length; // 快照: 排除中断轮的 aborted/stop
    const send3 = await fetchJson("POST", "/api/message", { text: "继续" });
    assert.strictEqual(send3.status, 200);
    const msg3 = await sse.waitFor((e) => e.kind === "assistant_message", 15000, mark11);
    assert.ok(msg3.text.includes("mock"), "恢复轮回复应来自 mock 脚本");
    await sse.waitFor((e) => e.kind === "stop", 15000, mark11);
    passed++; console.log("  ✓ 中断后恢复: 新消息正常处理");

    // 11b. 失败工具 → 遥测 toolErrors 计数(mock 脚本 turn 3: ls 不存在路径 → 非零退出)
    const mark11b = sse.events.length;
    const send3b = await fetchJson("POST", "/api/message", { text: "失败演示" });
    assert.strictEqual(send3b.status, 200);
    const failStart = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.input.command === "ls /definitely-not-exist-xyz", 15000, mark11b
    );
    await sse.waitFor((e) => e.kind === "tool_result" && e.id === failStart.id && e.isError, 15000, mark11b);
    await sse.waitFor((e) => e.kind === "stop", 15000, mark11b);
    passed++; console.log("  ✓ 失败工具 → error tool_result(遥测 toolErrors 计数, 14 号用例断言)");

    // 12. 多会话并发: A 挂起权限弹窗期间 B 独立运行(事件带 sessionId 标记)
    const mark12 = sse.events.length;
    const aRes = await fetchJson("POST", "/api/session/new");
    const sessA = aRes.body.sessionId;
    assert.ok(sessA, "新建会话响应应含 sessionId");
    const sendA = await fetchJson("POST", "/api/message", { text: "看下目录和时间" }); // lastActive = A
    assert.strictEqual(sendA.status, 200);
    const aLs = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessA && e.input.command === "ls -la", 15000, mark12
    );
    assert.strictEqual(aLs.sessionId, sessA, "事件应带 sessionId 标记");
    await sse.waitFor((e) => e.kind === "tool_result" && e.sessionId === sessA && e.id === aLs.id && !e.isError, 15000, mark12);
    const aPerm = await sse.waitFor((e) => e.kind === "permission_request" && e.sessionId === sessA, 15000, mark12);
    const aDate = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessA && e.input.command === "date", 15000, mark12
    );
    // B: 新建并发消息 → 在 A 弹窗挂起期间独立跑完 ls(跨会话并发, 不被 A 的 sendChain 阻塞)
    const bRes = await fetchJson("POST", "/api/session/new");
    const sessB = bRes.body.sessionId;
    assert.notStrictEqual(sessB, sessA);
    const sendB = await fetchJson("POST", "/api/message", { text: "看下目录和时间", sessionId: sessB });
    assert.strictEqual(sendB.status, 200);
    assert.strictEqual(sendB.body.sessionId, sessB);
    const bLs = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessB && e.input.command === "ls -la", 15000, mark12
    );
    await sse.waitFor((e) => e.kind === "tool_result" && e.sessionId === sessB && e.id === bLs.id && !e.isError, 15000, mark12);
    const bPerm = await sse.waitFor((e) => e.kind === "permission_request" && e.sessionId === sessB, 15000, mark12);
    passed++; console.log("  ✓ 多会话并发: A 挂起弹窗期间 B 独立运行(SSE 事件按 sessionId 标记)");

    // 12a. abort 按会话隔离: 只中断 B(B 弹窗冲洗拒绝 + aborted), A 弹窗原封不动 → 应答后 A 完整走完
    const abortB = await fetchJson("POST", "/api/abort", { sessionId: sessB });
    assert.strictEqual(abortB.status, 200);
    assert.strictEqual(abortB.body.running, true);
    await sse.waitFor(
      (e) => e.kind === "permission_resolved" && e.sessionId === sessB && e.id === bPerm.id && e.answer === "no", 15000, mark12
    );
    await sse.waitFor((e) => e.kind === "aborted" && e.sessionId === sessB, 15000, mark12);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessB, 15000, mark12);
    // A 的弹窗未被 B 的 abort 冲洗(仍挂起) → 应答 yes → A 的 date 放行执行 + 完整收尾
    const answerA = await fetchJson("POST", `/api/permission/${encodeURIComponent(aPerm.id)}`, { answer: "yes" });
    assert.strictEqual(answerA.status, 200);
    await sse.waitFor((e) => e.kind === "tool_result" && e.sessionId === sessA && e.id === aDate.id && !e.isError, 15000, mark12);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessA, 15000, mark12);
    passed++; console.log("  ✓ abort 会话隔离: B 中断不影响 A(A 弹窗存活 → 应答后完整走完)");

    // 12b. 双 transcript 独立落盘
    assert.ok(fs.existsSync(path.join(ROOT, ".agent-harness", "sessions", `${sessA}.jsonl`)), "A transcript 应存在");
    assert.ok(fs.existsSync(path.join(ROOT, ".agent-harness", "sessions", `${sessB}.jsonl`)), "B transcript 应存在");
    passed++; console.log("  ✓ 多会话 transcript 独立落盘");

    // 13. 会话历史端点: 显式回放 + running 态; 未知会话 → 404
    const histA = await fetchJson("GET", `/api/session/history?sessionId=${encodeURIComponent(sessA)}`);
    assert.strictEqual(histA.status, 200);
    assert.strictEqual(histA.body.sessionId, sessA);
    assert.strictEqual(histA.body.running, false);
    assert.ok(histA.body.events.some((e) => e.kind === "user_message"), "回放应含用户消息");
    assert.ok(histA.body.events.some((e) => e.kind === "tool_result"), "回放应含工具结果");
    const hist404 = await fetchJson("GET", "/api/session/history?sessionId=nope");
    assert.strictEqual(hist404.status, 404);
    // 活动会话重复 resume → 仅切换不重置(provider 状态/消息树保留)
    const reResume = await fetchJson("POST", "/api/session/resume", { sessionId: sessA });
    assert.strictEqual(reResume.status, 200);
    const histA2 = await fetchJson("GET", `/api/session/history?sessionId=${encodeURIComponent(sessA)}`);
    assert.strictEqual(histA2.body.events.length, histA.body.events.length, "重复 resume 不应清空消息树");
    passed++; console.log("  ✓ 会话历史端点 + 活动会话重复 resume 不重置");

    // 14. 遥测汇总: 错误分类计数 + 活动会话轮次
    const stats = await fetchJson("GET", "/api/stats");
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.errors.total, 0, "无引擎级异常(中断/权限拒绝不计)");
    assert.strictEqual(stats.body.errors.toolErrors, 1, "仅 11b 的一次工具失败");
    assert.ok(typeof stats.body.errors.byCategory === "object");
    assert.ok(stats.body.sessions.live >= 2, "至少 2 个活动会话");
    assert.ok(stats.body.sessions.recorded >= stats.body.sessions.live);
    const liveA = stats.body.liveSessions.find((s) => s.id === sessA);
    assert.ok(liveA, "stats 应含 sessA");
    assert.ok(liveA.turns >= 3, "A 至少 3 轮(ls/date/文本)");
    assert.ok(stats.body.logFile.includes("telemetry"), "错误 JSONL 落盘路径");
    passed++; console.log("  ✓ 遥测汇总 /api/stats: toolErrors=1, 活动会话轮次与计数");

    // 15. transcript 持久化(旧会话存在)
    const sess2 = await fetchJson("GET", "/api/sessions");
    const first = sess2.body.sessions.find((s) => s.id !== ready2.sessionId);
    assert.ok(first, "应存在旧会话");

    // 16. 会话级"总是允许" e2e: 弹窗携带 alwaysRule → always 应答 → 同会话再触发免弹窗(session-allow);
    //     新会话不继承记忆(重新弹窗)。注意: 本块的失败工具轮会使 toolErrors +1, 必须置于 14 号 stats 断言之后
    const cRes = await fetchJson("POST", "/api/session/new");
    const sessC = cRes.body.sessionId;
    await sse.waitFor((e) => e.kind === "ready" && e.sessionId === sessC, 15000);
    const mark16 = sse.events.length; // 快照: 排除 sessC 的 ready/history
    const sendC = await fetchJson("POST", "/api/message", { text: "看下时间", sessionId: sessC });
    assert.strictEqual(sendC.status, 200);
    await sse.waitFor((e) => e.kind === "tool_start" && e.sessionId === sessC && e.input.command === "ls -la", 15000, mark16);
    // date 弹窗: 携带推导的 always 规则; Bash 无 diff 预览
    const cPerm = await sse.waitFor(
      (e) => e.kind === "permission_request" && e.sessionId === sessC && e.input.command === "date", 15000, mark16
    );
    assert.strictEqual(cPerm.alwaysRule, "Bash(date:*)", "弹窗应携带推导的 always 规则");
    assert.strictEqual(cPerm.preview, undefined, "Bash 无 diff 预览");
    const ansC = await fetchJson("POST", `/api/permission/${encodeURIComponent(cPerm.id)}`, { answer: "always" });
    assert.strictEqual(ansC.status, 200);
    await sse.waitFor((e) => e.kind === "permission_resolved" && e.id === cPerm.id && e.answer === "always", 15000, mark16);
    const cDate = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessC && e.input.command === "date", 15000, mark16
    );
    await sse.waitFor(
      (e) => e.kind === "perm" && e.sessionId === sessC && e.source === "user" && e.decision === "allow", 15000, mark16
    );
    await sse.waitFor((e) => e.kind === "tool_result" && e.sessionId === sessC && e.id === cDate.id && !e.isError, 15000, mark16);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessC, 15000, mark16);
    passed++; console.log("  ✓ always e2e: 弹窗携带 alwaysRule + always resolve + 放行执行");

    // 16a. 同会话 msg2 消费 turn4/5(失败工具轮), msg3 的 date 命中会话记忆 → session-allow 免弹窗
    const mark16b = sse.events.length;
    await fetchJson("POST", "/api/message", { text: "失败演示", sessionId: sessC });
    const cFail = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessC && e.input.command === "ls /definitely-not-exist-xyz", 15000, mark16b
    );
    await sse.waitFor((e) => e.kind === "tool_result" && e.sessionId === sessC && e.id === cFail.id && e.isError, 15000, mark16b);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessC, 15000, mark16b);
    const mark16c = sse.events.length;
    await fetchJson("POST", "/api/message", { text: "再看时间", sessionId: sessC });
    const cDate2 = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessC && e.input.command === "date", 15000, mark16c
    );
    await sse.waitFor(
      (e) => e.kind === "perm" && e.sessionId === sessC && e.source === "session-allow", 15000, mark16c
    );
    await sse.waitFor((e) => e.kind === "tool_result" && e.sessionId === sessC && e.id === cDate2.id && !e.isError, 15000, mark16c);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessC, 15000, mark16c);
    assert.strictEqual(
      sse.events.slice(mark16c).filter((e) => e.kind === "permission_request" && e.sessionId === sessC).length,
      0,
      "会话记忆命中后不应再弹窗"
    );
    passed++; console.log("  ✓ 会话级记忆: 同会话再触发 date → session-allow 免弹窗");

    // 16b. 记忆不跨会话: 新会话 date 重新弹窗 → no 拒绝收尾
    const dRes = await fetchJson("POST", "/api/session/new");
    const sessD = dRes.body.sessionId;
    await sse.waitFor((e) => e.kind === "ready" && e.sessionId === sessD, 15000);
    const mark16d = sse.events.length;
    await fetchJson("POST", "/api/message", { text: "看下时间", sessionId: sessD });
    const dPerm = await sse.waitFor(
      (e) => e.kind === "permission_request" && e.sessionId === sessD && e.input.command === "date", 15000, mark16d
    );
    assert.strictEqual(dPerm.alwaysRule, "Bash(date:*)", "新会话仍提供 always 选项(记忆不继承)");
    const ansD = await fetchJson("POST", `/api/permission/${encodeURIComponent(dPerm.id)}`, { answer: "no" });
    assert.strictEqual(ansD.status, 200);
    await sse.waitFor((e) => e.kind === "permission_resolved" && e.id === dPerm.id && e.answer === "no", 15000, mark16d);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessD, 15000, mark16d);
    passed++; console.log("  ✓ 记忆不跨会话: 新会话 date 重新弹窗 → no 收尾");

    // 17. 工具输入校验 e2e: 坏输入(Bash 缺 command)被调度层形状校验拦截 → 不弹窗直接 error 结果。
    //     sessC 已消费 mock 脚本前 7 轮(16/16a), 本轮消费 append 的第 8/9 轮;
    //     置于 14 号 stats 断言之后(校验失败计入 toolErrors, 会使全局计数 +1, 不再断言)
    const mark17 = sse.events.length;
    await fetchJson("POST", "/api/message", { text: "坏输入演示", sessionId: sessC });
    const badStart = await sse.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sessC && e.input && e.input.timeout === 30000, 15000, mark17
    );
    assert.strictEqual(badStart.name, "Bash");
    const badResult = await sse.waitFor(
      (e) => e.kind === "tool_result" && e.sessionId === sessC && e.id === badStart.id && e.isError, 15000, mark17
    );
    assert.ok(badResult.output.includes("工具输入校验失败(Bash)"), badResult.output);
    assert.ok(badResult.output.includes("command") && badResult.output.includes("必填"), badResult.output);
    await sse.waitFor((e) => e.kind === "stop" && e.sessionId === sessC, 15000, mark17);
    assert.strictEqual(
      sse.events.slice(mark17).filter((e) => e.kind === "permission_request" && e.sessionId === sessC).length,
      0,
      "校验失败先于权限瀑布, 不应弹窗"
    );
    passed++; console.log("  ✓ 工具输入校验 e2e: 坏输入不弹窗直接 error tool_result(计入遥测)");

    // 18. 分层配置 e2e: 独立 spawn(AGENT_HARNESS_HOME 指向含用户级 allow 规则的临时目录)→
    //     date 未命中项目级规则, 被用户级 Bash(date:*) 跨层放行 → 全程无弹窗。
    //     独立端口 + 独立 provider → 不影响既有 17 个测试的 mock 轮次记账
    const PORT2 = 3998;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const userHome18 = fs.mkdtempSync(path.join(os.tmpdir(), "web-smoke-user-"));
    fs.writeFileSync(path.join(userHome18, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(date:*)"] } }));
    const server2 = spawn("node", ["dist/cli.js", "web"], {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        PORT: String(PORT2),
        AUTH_TOKEN: TOKEN,
        AGENT_HARNESS_NO_KEYCHAIN: "1",
        AGENT_HARNESS_HOME: userHome18,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let server2Err = "";
    server2.stderr.on("data", (d) => (server2Err += d.toString()));
    let up2 = false;
    for (let i = 0; i < 40 && !up2; i++) {
      await sleep(250);
      try {
        await fetchJson("GET", "/api/sessions", undefined, TOKEN, BASE2);
        up2 = true;
      } catch { /* 等待启动 */ }
    }
    assert.ok(up2, `分层配置 e2e 服务器未启动\nstderr: ${server2Err.slice(0, 1000)}`);
    const sse18 = sseCollect(TOKEN, BASE2);
    await sse18.waitFor((e) => e.kind === "ready"); // SSE 连接即补放活动会话 ready
    const send18 = await fetchJson("POST", "/api/message", { text: "看下目录和时间" }, TOKEN, BASE2);
    assert.strictEqual(send18.status, 200);
    const ls18 = await sse18.waitFor((e) => e.kind === "tool_start" && e.input && e.input.command === "ls -la");
    await sse18.waitFor((e) => e.kind === "tool_result" && e.id === ls18.id && !e.isError); // 项目级 Bash(ls:*) 放行
    const date18 = await sse18.waitFor((e) => e.kind === "tool_start" && e.input && e.input.command === "date");
    await sse18.waitFor((e) => e.kind === "tool_result" && e.id === date18.id && !e.isError); // 用户级 Bash(date:*) 放行
    await sse18.waitFor((e) => e.kind === "stop");
    assert.strictEqual(
      sse18.events.filter((e) => e.kind === "permission_request").length,
      0,
      "用户级规则放行 date, 全程不应弹窗"
    );
    sse18.close();
    server2.kill("SIGTERM");
    fs.rmSync(userHome18, { recursive: true, force: true });
    passed++; console.log("  ✓ 分层配置 e2e: 用户级 allow 规则跨层生效(date 免弹窗直执行)");

    // 19. Slash 命令 + 模式运行中切换 e2e: 独立 spawn(独立 provider, mock 轮次从 1 起算, 不影响前 18 项)。
    //     /mode plan → command_output + mode_changed(不入消息树);plan 下只读放行/非只读 plan-mode 拒;
    //     /api/mode(徽章下拉路径)切回 default → date 重新弹窗;bypassPermissions 双保险(UI 400 + 命令须 --dangerous)
    const PORT3 = 3997;
    const BASE3 = `http://127.0.0.1:${PORT3}`;
    const home19 = fs.mkdtempSync(path.join(os.tmpdir(), "web-smoke-home19-"));
    const server3 = spawn("node", ["dist/cli.js", "web"], {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        PORT: String(PORT3),
        AUTH_TOKEN: TOKEN,
        AGENT_HARNESS_NO_KEYCHAIN: "1",
        AGENT_HARNESS_HOME: home19,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let server3Err = "";
    server3.stderr.on("data", (d) => (server3Err += d.toString()));
    let up3 = false;
    for (let i = 0; i < 40 && !up3; i++) {
      await sleep(250);
      try {
        await fetchJson("GET", "/api/sessions", undefined, TOKEN, BASE3);
        up3 = true;
      } catch { /* 等待启动 */ }
    }
    assert.ok(up3, `模式切换 e2e 服务器未启动\nstderr: ${server3Err.slice(0, 1000)}`);
    const sse19 = sseCollect(TOKEN, BASE3);
    const ready19 = await sse19.waitFor((e) => e.kind === "ready");
    assert.strictEqual(ready19.mode, "default");
    const sess19 = ready19.sessionId;

    // 19a. /mode plan: 命令拦截 → command_output + mode_changed;不进消息树不触发 LLM(mock 轮次零消耗)
    const mark19a = sse19.events.length;
    const cmd19 = await fetchJson("POST", "/api/message", { text: "/mode plan", sessionId: sess19 }, TOKEN, BASE3);
    assert.strictEqual(cmd19.status, 200);
    assert.strictEqual(cmd19.body.command, true);
    await sse19.waitFor(
      (e) => e.kind === "command_output" && e.sessionId === sess19 && e.text.includes("权限模式已切换: plan"), 15000, mark19a
    );
    await sse19.waitFor((e) => e.kind === "mode_changed" && e.sessionId === sess19 && e.mode === "plan", 15000, mark19a);
    assert.strictEqual(
      sse19.events.slice(mark19a).filter((e) => e.kind === "user_message" || e.kind === "tool_start").length,
      0,
      "命令不入消息树不触发工具"
    );
    passed++; console.log("  ✓ /mode 命令 e2e: command_output + mode_changed, 不入消息树不消耗 LLM 轮次");

    // 19b. plan 语义: 消息消费 mock 轮 1-3 → ls -la 只读放行(static);date 非只读 → plan-mode 拒(不弹窗)
    const mark19b = sse19.events.length;
    await fetchJson("POST", "/api/message", { text: "看下目录和时间", sessionId: sess19 }, TOKEN, BASE3);
    const ls19 = await sse19.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sess19 && e.input && e.input.command === "ls -la", 15000, mark19b
    );
    await sse19.waitFor(
      (e) => e.kind === "perm" && e.sessionId === sess19 && e.source === "static" && e.decision === "allow", 15000, mark19b
    );
    await sse19.waitFor((e) => e.kind === "tool_result" && e.sessionId === sess19 && e.id === ls19.id && !e.isError, 15000, mark19b);
    const date19 = await sse19.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sess19 && e.input && e.input.command === "date", 15000, mark19b
    );
    await sse19.waitFor(
      (e) => e.kind === "perm" && e.sessionId === sess19 && e.source === "plan-mode" && e.decision === "deny", 15000, mark19b
    );
    await sse19.waitFor((e) => e.kind === "tool_result" && e.sessionId === sess19 && e.id === date19.id && e.isError, 15000, mark19b);
    await sse19.waitFor((e) => e.kind === "stop" && e.sessionId === sess19, 15000, mark19b);
    assert.strictEqual(sse19.events.slice(mark19b).filter((e) => e.kind === "permission_request").length, 0, "plan 拒绝不弹窗");
    passed++; console.log("  ✓ plan 模式 e2e: 只读放行, 非只读 plan-mode 拒绝(无弹窗)");

    // 19c. /api/mode(徽章下拉路径)切回 default: mode_changed + history 实时回显;UI 不暴露 bypassPermissions(400)
    const mark19c = sse19.events.length;
    const mode19 = await fetchJson("POST", "/api/mode", { mode: "default", sessionId: sess19 }, TOKEN, BASE3);
    assert.strictEqual(mode19.status, 200);
    await sse19.waitFor((e) => e.kind === "mode_changed" && e.sessionId === sess19 && e.mode === "default", 15000, mark19c);
    const hist19 = await fetchJson("GET", `/api/session/history?sessionId=${encodeURIComponent(sess19)}`, undefined, TOKEN, BASE3);
    assert.strictEqual(hist19.body.mode, "default", "历史端点回显实时模式");
    const badMode19 = await fetchJson("POST", "/api/mode", { mode: "bypassPermissions", sessionId: sess19 }, TOKEN, BASE3);
    assert.strictEqual(badMode19.status, 400, "bypassPermissions 不在 UI 暴露");
    passed++; console.log("  ✓ /api/mode 端点: 下拉切换 + history 实时回显 + bypassPermissions 400");

    // 19d. 消费 mock 轮 4-5(ls /definitely-not-exist → 真实失败但 default 放行)
    const mark19d = sse19.events.length;
    await fetchJson("POST", "/api/message", { text: "失败演示", sessionId: sess19 }, TOKEN, BASE3);
    const fail19 = await sse19.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sess19 && e.input && e.input.command === "ls /definitely-not-exist-xyz", 15000, mark19d
    );
    await sse19.waitFor((e) => e.kind === "tool_result" && e.sessionId === sess19 && e.id === fail19.id && e.isError, 15000, mark19d);
    await sse19.waitFor((e) => e.kind === "stop" && e.sessionId === sess19, 15000, mark19d);

    // 19e. default 下 date 重新弹窗(切换后弹窗链路完好)→ yes 放行 → 消费 mock 轮 6-7
    const mark19e = sse19.events.length;
    await fetchJson("POST", "/api/message", { text: "再看时间", sessionId: sess19 }, TOKEN, BASE3);
    const date19b = await sse19.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sess19 && e.input && e.input.command === "date", 15000, mark19e
    );
    const perm19 = await sse19.waitFor(
      (e) => e.kind === "permission_request" && e.sessionId === sess19 && e.input && e.input.command === "date", 15000, mark19e
    );
    await fetchJson("POST", `/api/permission/${encodeURIComponent(perm19.id)}`, { answer: "yes" }, TOKEN, BASE3);
    await sse19.waitFor((e) => e.kind === "tool_result" && e.sessionId === sess19 && e.id === date19b.id && !e.isError, 15000, mark19e);
    await sse19.waitFor((e) => e.kind === "stop" && e.sessionId === sess19, 15000, mark19e);
    passed++; console.log("  ✓ 模式切回后弹窗链路完好: date → 弹窗 → yes 放行执行");

    // 19f. 命令矩阵: 未知模式报错;bypass 无 --dangerous 拒 / 带 --dangerous 切;/status /permissions 回流;切回 default
    const mark19f = sse19.events.length;
    await fetchJson("POST", "/api/message", { text: "/mode fast", sessionId: sess19 }, TOKEN, BASE3);
    await sse19.waitFor(
      (e) => e.kind === "command_output" && e.sessionId === sess19 && e.text.includes("未知模式"), 15000, mark19f
    );
    await fetchJson("POST", "/api/message", { text: "/mode bypassPermissions", sessionId: sess19 }, TOKEN, BASE3);
    await sse19.waitFor(
      (e) => e.kind === "command_output" && e.sessionId === sess19 && e.text.includes("--dangerous"), 15000, mark19f
    );
    assert.strictEqual(
      sse19.events.slice(mark19f).filter((e) => e.kind === "mode_changed").length, 0,
      "非法/未确认切换不应产生 mode_changed"
    );
    await fetchJson("POST", "/api/message", { text: "/mode bypassPermissions --dangerous", sessionId: sess19 }, TOKEN, BASE3);
    await sse19.waitFor(
      (e) => e.kind === "mode_changed" && e.sessionId === sess19 && e.mode === "bypassPermissions", 15000, mark19f
    );
    await fetchJson("POST", "/api/message", { text: "/status", sessionId: sess19 }, TOKEN, BASE3);
    await sse19.waitFor(
      (e) => e.kind === "command_output" && e.sessionId === sess19 && e.text.includes("[status]") && e.text.includes("bypassPermissions"), 15000, mark19f
    );
    await fetchJson("POST", "/api/message", { text: "/permissions", sessionId: sess19 }, TOKEN, BASE3);
    await sse19.waitFor(
      (e) => e.kind === "command_output" && e.sessionId === sess19 && e.text.includes("[permissions]"), 15000, mark19f
    );
    await fetchJson("POST", "/api/message", { text: "/mode default", sessionId: sess19 }, TOKEN, BASE3);
    await sse19.waitFor(
      (e) => e.kind === "mode_changed" && e.sessionId === sess19 && e.mode === "default", 15000, mark19f
    );
    passed++; console.log("  ✓ 命令矩阵: 未知模式/双确认 bypass/状态与规则回流/切回 default");

    sse19.close();
    server3.kill("SIGTERM");
    fs.rmSync(home19, { recursive: true, force: true });

    // 20. 用量仪表盘 e2e: 独立 spawn → 独立 telemetry(usage 内存聚合只含本段记录, 断言确定性)。
    //     三轮会话(ls 放行 → date 弹窗 no → 文本收尾)验证三条数据链路:
    //     每轮 usage SSE 事件(轮入口水位快照) / GET /api/usage(5h 窗口聚合) / /usage 命令(同源格式化)
    const PORT4 = 3996;
    const BASE4 = `http://127.0.0.1:${PORT4}`;
    const home20 = fs.mkdtempSync(path.join(os.tmpdir(), "web-smoke-home20-"));
    const server4 = spawn("node", ["dist/cli.js", "web"], {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        PORT: String(PORT4),
        AUTH_TOKEN: TOKEN,
        AGENT_HARNESS_NO_KEYCHAIN: "1",
        AGENT_HARNESS_HOME: home20,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let server4Err = "";
    server4.stderr.on("data", (d) => (server4Err += d.toString()));
    let up4 = false;
    for (let i = 0; i < 40 && !up4; i++) {
      await sleep(250);
      try {
        await fetchJson("GET", "/api/sessions", undefined, TOKEN, BASE4);
        up4 = true;
      } catch { /* 等待启动 */ }
    }
    assert.ok(up4, `用量仪表盘 e2e 服务器未启动\nstderr: ${server4Err.slice(0, 1000)}`);
    const sse20 = sseCollect(TOKEN, BASE4);
    const ready20 = await sse20.waitFor((e) => e.kind === "ready");
    const sess20 = ready20.sessionId;

    // 20a. 三轮会话: 每轮入口恰一个 usage 事件(turn/buffer 快照 + 水位阈值, sessionId 标记)
    const mark20 = sse20.events.length;
    await fetchJson("POST", "/api/message", { text: "看下目录和时间", sessionId: sess20 }, TOKEN, BASE4);
    const ls20 = await sse20.waitFor(
      (e) => e.kind === "tool_start" && e.sessionId === sess20 && e.input && e.input.command === "ls -la", 15000, mark20
    );
    await sse20.waitFor((e) => e.kind === "tool_result" && e.sessionId === sess20 && e.id === ls20.id && !e.isError, 15000, mark20);
    const perm20 = await sse20.waitFor(
      (e) => e.kind === "permission_request" && e.sessionId === sess20 && e.input && e.input.command === "date", 15000, mark20
    );
    await fetchJson("POST", `/api/permission/${encodeURIComponent(perm20.id)}`, { answer: "no" }, TOKEN, BASE4);
    await sse20.waitFor((e) => e.kind === "stop" && e.sessionId === sess20, 15000, mark20);
    const usages20 = sse20.events.slice(mark20).filter((e) => e.kind === "usage" && e.sessionId === sess20);
    assert.ok(usages20.length >= 3, `三轮会话应 ≥3 个 usage 事件(实际 ${usages20.length})`);
    assert.strictEqual(usages20[0].turn, 1, "首个 usage 事件为 turn 1");
    assert.strictEqual(usages20[0].totalTokensUsed, 0, "轮入口快照: 首事件为首次调用前累计");
    for (const u of usages20.slice(0, 3)) {
      assert.ok(u.bufferTokens > 0, "buffer 为本轮请求上下文规模");
      for (const k of ["effectiveWindow", "autoCompactAt", "warningAt", "blockingAt"]) {
        assert.ok(typeof u.watermarks[k] === "number", `watermarks.${k}`);
      }
    }
    passed++; console.log("  ✓ usage SSE 事件: 每轮水位快照(turn/buffer/水位阈值, sessionId 标记)");

    // 20b. GET /api/usage: 5h 窗口聚合(Mock 合成 usage → 非零) + 活动会话实时累计
    const usage20 = await fetchJson("GET", "/api/usage", undefined, TOKEN, BASE4);
    assert.strictEqual(usage20.status, 200);
    assert.ok(usage20.body.calls >= 3, `窗口内调用数 ≥3(实际 ${usage20.body.calls})`);
    assert.ok(usage20.body.totals.input > 0 && usage20.body.totals.output > 0, "Mock 合成 usage → in/out 非零");
    assert.ok(usage20.body.totals.total > 0);
    assert.ok(usage20.body.since, "窗口起点 ts");
    const live20 = (usage20.body.liveSessions ?? []).find((l) => l.id === sess20);
    assert.ok(live20, "活动会话列表含当前会话");
    assert.ok(live20.tokensUsed > 0, "Mock 合成 usage → 会话累计计费 tokens 非零");
    assert.strictEqual(live20.turns, 3, "三轮会话");
    passed++; console.log("  ✓ GET /api/usage: 5h 窗口聚合 + 活动会话实时用量");

    // 20c. /usage 命令: command_output 回流同源格式化(不消耗 mock 轮次)
    const mark20c = sse20.events.length;
    const cmd20 = await fetchJson("POST", "/api/message", { text: "/usage", sessionId: sess20 }, TOKEN, BASE4);
    assert.strictEqual(cmd20.status, 200);
    assert.strictEqual(cmd20.body.command, true);
    await sse20.waitFor(
      (e) => e.kind === "command_output" && e.sessionId === sess20 && e.text.includes("[usage]") && e.text.includes("5h"), 15000, mark20c
    );
    passed++; console.log("  ✓ /usage 命令: 5h 用量窗口经 command_output 回流");

    sse20.close();
    server4.kill("SIGTERM");
    fs.rmSync(home20, { recursive: true, force: true });

    sse.close();
    fs.rmSync(emptyHome, { recursive: true, force: true });
    console.log(`\n[web-smoke] 全部通过: ${passed} 项`);
    server.kill("SIGTERM");
    process.exit(0);
  } catch (e) {
    console.error(`\n[web-smoke] 失败: ${e.message}`);
    console.error(`stderr: ${serverErr.slice(0, 2000)}`);
    if (sse) console.error("已收到事件(尾部):", JSON.stringify(sse.events.map((x) => ({ kind: x.kind, id: x.id, sessionId: x.sessionId, source: x.source, decision: x.decision, answer: x.answer, isError: x.isError })).slice(-30), null, 1));
    killServer();
    process.exit(1);
  }
})();
