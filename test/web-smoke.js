// test/web-smoke.js — Web 模式冒烟测试(mock provider, 无需 API key)
// 覆盖: 静态页 / SSE 事件流(ready/history) / 消息发送 → 工具卡片事件(ls 白名单放行) /
//       权限弹窗桥接(date 未命中规则 → permission_request → HTTP 应答 → 放行执行) /
//       stop 收尾 / 会话列表 / 新建会话
// 用法: npm run build && node test/web-smoke.js
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..");

function fetchJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${url}`, { method, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// SSE 客户端: 收集事件, 提供 waitFor 谓词
function sseCollect() {
  const events = [];
  const waiters = [];
  const req = http.get(`${BASE}/api/events`, (res) => {
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
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i](ev)) waiters.splice(i, 1);
        }
      }
    });
  });
  return {
    events,
    waitFor(pred, timeoutMs = 15000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("waitFor 超时")), timeoutMs);
        waiters.push((ev) => {
          if (pred(ev)) {
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
  // ── 启动服务器(mock 模式: 清空 ANTHROPIC_API_KEY) ──
  const server = spawn("node", ["dist/cli.js", "web"], {
    cwd: ROOT,
    env: { ...process.env, ANTHROPIC_API_KEY: "", PORT: String(PORT) },
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
    // 1. 静态页
    const page = await new Promise((resolve, reject) => {
      http.get(`${BASE}/`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }).on("error", reject);
    });
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes("agent-harness"), "首页应含 agent-harness");
    passed++; console.log("  ✓ 静态首页 200");

    // 2. SSE: ready + history
    sse = sseCollect();
    await sse.waitFor((e) => e.kind === "ready");
    assert.ok(sse.events.some((e) => e.kind === "history"));
    passed++; console.log("  ✓ SSE ready/history 事件");

    // 3. 发消息 → mock 脚本: ls(白名单放行) → date(弹窗) → 文本 → stop
    const send1 = await fetchJson("POST", "/api/message", { text: "看下目录和时间" });
    assert.strictEqual(send1.status, 200);

    const lsStart = await sse.waitFor((e) => e.kind === "tool_start" && e.input.command === "ls -la");
    assert.strictEqual(lsStart.name, "Bash");
    await sse.waitFor((e) => e.kind === "perm" && e.decision === "allow" && e.source === "static");
    await sse.waitFor((e) => e.kind === "tool_result" && e.id === lsStart.id && !e.isError);
    passed++; console.log("  ✓ 工具卡片事件: tool_start/perm(白名单)/tool_result");

    // 4. 权限弹窗桥接: date 未命中规则 → permission_request → HTTP 应答 yes → 放行执行
    const dateStart = await sse.waitFor((e) => e.kind === "tool_start" && e.input.command === "date");
    const permReq = await sse.waitFor((e) => e.kind === "permission_request");
    assert.strictEqual(permReq.toolName, "Bash");
    assert.strictEqual(permReq.input.command, "date");
    // 4a. SSE 重连补放: 挂起中的权限请求必须重放给新连接(页面刷新后弹窗不丢失)
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

    // 5. 文本回复 + stop
    const msg = await sse.waitFor((e) => e.kind === "assistant_message");
    assert.ok(msg.text.includes("mock"), "回复应来自 mock 脚本");
    await sse.waitFor((e) => e.kind === "stop");
    passed++; console.log("  ✓ assistant_message + stop 收尾");

    // 6. 重复应答 → 404(幂等保护)
    const again = await fetchJson("POST", `/api/permission/${encodeURIComponent(permReq.id)}`, { answer: "no" });
    assert.strictEqual(again.status, 404);
    passed++; console.log("  ✓ 权限请求重复应答 → 404");

    // 7. 会话列表
    const sess = await fetchJson("GET", "/api/sessions");
    assert.ok(sess.body.sessions.some((s) => s.id.startsWith("sess_web_")));
    passed++; console.log("  ✓ 会话列表");

    // 8. 新建会话 → ready 重播(history 清空)
    const newSess = await fetchJson("POST", "/api/session/new");
    assert.strictEqual(newSess.status, 200);
    const ready2 = await sse.waitFor((e) => e.kind === "ready" && e.sessionId !== "", 15000);
    assert.ok(ready2.sessionId.startsWith("sess_web_"));
    const hist2 = await sse.waitFor((e) => e.kind === "history" && e.events.length === 0);
    assert.strictEqual(hist2.events.length, 0, "新会话 history 应为空");
    passed++; console.log("  ✓ 新建会话 → ready + 空 history");

    // 9. transcript 持久化(消息树落盘)
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
    if (sse) console.error("已收到事件(尾部):", JSON.stringify(sse.events.map((x) => ({ kind: x.kind, id: x.id, source: x.source, decision: x.decision, answer: x.answer })).slice(-30), null, 1));
    killServer();
    process.exit(1);
  }
})();
