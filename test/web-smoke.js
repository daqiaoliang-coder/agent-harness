// test/web-smoke.js — Web 模式冒烟测试(mock provider, 无需 API key)
// 覆盖: 鉴权(无/错 token → 401, 全端点含静态页/SSE) / 静态页 / SSE 事件流(ready/history) /
//       消息发送 → 工具卡片事件(ls 白名单放行) / 权限弹窗桥接(date 未命中规则 → 弹窗 → HTTP 应答) /
//       SSE 重连补放挂起弹窗 / stop 收尾 / 会话列表 / 新建会话 /
//       中断 e2e(权限等待中 POST /api/abort → 弹窗拒绝 + aborted + transcript 树一致 + 会话可继续) /
//       多会话并发(A 挂起弹窗不阻塞 B; 事件带 sessionId 标记; abort 按会话隔离) /
//       会话历史端点 / 活动会话重复 resume 不重置 / 遥测汇总(GET /api/stats)
// 用法: npm run build && node test/web-smoke.js
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..");
const TOKEN = "test-token-123"; // AUTH_TOKEN 环境变量固定 → 测试确定性

// token=null 不带 header(测 401); 其他值带 x-auth-token
function fetchJson(method, url, body, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (token !== null) headers["x-auth-token"] = token;
    const req = http.request(`${BASE}${url}`, { method, headers }, (res) => {
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
function sseCollect(token = TOKEN) {
  const events = [];
  const waiters = [];
  const req = http.get(`${BASE}/api/events?token=${encodeURIComponent(token)}`, (res) => {
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
  //    AGENT_HARNESS_NO_KEYCHAIN=1 防止读到开发者真实 Keychain key 导致 mock 模式失效) ──
  const server = spawn("node", ["dist/cli.js", "web"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      PORT: String(PORT),
      AUTH_TOKEN: TOKEN,
      AGENT_HARNESS_NO_KEYCHAIN: "1",
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

    sse.close();
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
