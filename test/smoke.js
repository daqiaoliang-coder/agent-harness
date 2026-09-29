// test/smoke.js — 冒烟测试(不依赖真实 API Key)
// 1) Edit 工具全分支: 先读后改 / 多处匹配 / 唯一替换 / replace_all / 新鲜度校验 / Write 后直接 Edit
// 2) AnthropicProvider 假服务端: 重试矩阵 / 413 与 prompt_too_long → ContextWindowExceededError /
//    请求体形状(cache_control 断点 / tools 透传) / usage 遥测 / content 过滤
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { EditTool } = require("../dist/tools/edit");
const { ReadTool } = require("../dist/tools/read");
const { WriteTool } = require("../dist/tools/write");
const { GlobTool } = require("../dist/tools/glob");
const { GrepTool } = require("../dist/tools/grep");
const { TaskTool } = require("../dist/tools/task");
const { createExploreAgent } = require("../dist/agent/subagent");
const { PermissionEngine } = require("../dist/permissions/engine");
const { HookRunner } = require("../dist/hooks/runner");
const { parseHookSettings } = require("../dist/hooks/events");
const { MockProvider } = require("../dist/llm/provider");
const { BashTool } = require("../dist/tools/bash");
const { DEMO_COMPACT_CONFIG } = require("../dist/compact/watermarks");
const { AnthropicProvider } = require("../dist/llm/anthropicProvider");
const { ContextWindowExceededError } = require("../dist/llm/provider");
const { loadTranscript } = require("../dist/session/resume");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  // ---------- Part 1: Edit 工具全分支 ----------
  console.log("[1] Edit 工具全分支");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-edit-"));
  const edit = new EditTool();
  const read = new ReadTool();
  const write = new WriteTool();
  const f1 = path.join(dir, "a.txt");
  fs.writeFileSync(f1, "alpha beta\ngamma alpha\n", "utf8");

  await test("未 Read 直接 Edit → 拒绝(先读后改)", async () => {
    const r = await edit.execute({ path: f1, old_string: "beta", new_string: "delta" });
    assert.ok(r.isError && r.content.includes("has not been read"), JSON.stringify(r));
  });

  await test("old_string 多处匹配且无 replace_all → 报错", async () => {
    await read.execute({ path: f1 });
    const r = await edit.execute({ path: f1, old_string: "alpha", new_string: "omega" });
    assert.ok(r.isError && r.content.includes("出现 2 次"), JSON.stringify(r));
  });

  await test("唯一匹配 → 替换成功且落盘", async () => {
    const r = await edit.execute({ path: f1, old_string: "beta", new_string: "delta" });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(f1, "utf8"), "alpha delta\ngamma alpha\n");
  });

  await test("replace_all: true → 全部替换", async () => {
    const r = await edit.execute({ path: f1, old_string: "alpha", new_string: "omega", replace_all: true });
    assert.ok(!r.isError && r.content.includes("替换 2 处"), JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(f1, "utf8"), "omega delta\ngamma omega\n");
  });

  await test("Read 后外部修改 → 新鲜度校验拒绝", async () => {
    await read.execute({ path: f1 });
    fs.writeFileSync(f1, "omega delta\ngamma omega\nTOUCHED-LONGER\n", "utf8"); // size 变化 → 必 stale
    const r = await edit.execute({ path: f1, old_string: "delta", new_string: "x" });
    assert.ok(r.isError && r.content.includes("新鲜度校验失败"), JSON.stringify(r));
  });

  await test("重新 Read → Edit 恢复可用", async () => {
    await read.execute({ path: f1 });
    const r = await edit.execute({ path: f1, old_string: "delta", new_string: "epsilon" });
    assert.ok(!r.isError, JSON.stringify(r));
  });

  await test("old_string 未找到 → 报错含文件开头预览", async () => {
    const r = await edit.execute({ path: f1, old_string: "不存在的串", new_string: "x" });
    assert.ok(r.isError && r.content.includes("未在") && r.content.includes("文件开头"), JSON.stringify(r));
  });

  await test("Write 新文件 → 无需 Read 直接 Edit(markWritten)", async () => {
    const f2 = path.join(dir, "b.txt");
    const w = await write.execute({ path: f2, content: "one two three\n" });
    assert.ok(!w.isError, JSON.stringify(w));
    const r = await edit.execute({ path: f2, old_string: "two", new_string: "2" });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(f2, "utf8"), "one 2 three\n");
  });

  // ---------- Part 2: Glob / Grep / transcript resume ----------
  console.log("[2] Glob / Grep / resume");
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-glob-"));
  const glob = new GlobTool();
  const grep = new GrepTool();
  // 文件树: a.ts, src/b.ts, src/sub/c.ts, d.txt
  fs.mkdirSync(path.join(dir2, "src", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir2, "a.ts"), "export const ALPHA = 1;\n");
  fs.writeFileSync(path.join(dir2, "src", "b.ts"), "const beta = ALPHA + 1;\n");
  fs.writeFileSync(path.join(dir2, "src", "sub", "c.ts"), "// deep\n");
  fs.writeFileSync(path.join(dir2, "d.txt"), "ALPHA in txt\n");
  const ls = (r) => r.content.split("\n").filter((l) => l && !l.startsWith("(") && !l.startsWith("…"));

  await test("Glob *.ts 只匹配顶层", async () => {
    const r = await glob.execute({ pattern: "*.ts", path: dir2 });
    assert.ok(!r.isError);
    assert.deepStrictEqual(ls(r), ["a.ts"]);
  });

  await test("Glob **/*.ts 跨目录匹配", async () => {
    const r = await glob.execute({ pattern: "**/*.ts", path: dir2 });
    assert.deepStrictEqual(new Set(ls(r)), new Set(["a.ts", "src/b.ts", "src/sub/c.ts"]));
  });

  await test("Glob src/**/*.ts 前缀限定", async () => {
    const r = await glob.execute({ pattern: "src/**/*.ts", path: dir2 });
    assert.deepStrictEqual(new Set(ls(r)), new Set(["src/b.ts", "src/sub/c.ts"]));
  });

  await test("Glob 无匹配 → 空结果提示", async () => {
    const r = await glob.execute({ pattern: "*.rs", path: dir2 });
    assert.ok(!r.isError && r.content.includes("未找到"));
  });

  await test("Grep 递归命中 path:line:content 格式", async () => {
    const r = await grep.execute({ pattern: "ALPHA", path: dir2 });
    assert.ok(!r.isError);
    const lines = r.content.split("\n");
    assert.ok(lines.some((l) => /^a\.ts:1:/.test(l)), r.content);
    assert.ok(lines.some((l) => /^src\/b\.ts:1:/.test(l)), r.content);
    assert.ok(r.content.includes("命中"));
  });

  await test("Grep glob 参数过滤文件名", async () => {
    const r = await grep.execute({ pattern: "ALPHA", path: dir2, glob: "*.txt" });
    assert.ok(r.content.includes("d.txt:1:"), r.content);
    assert.ok(!r.content.includes("a.ts:1:"), r.content);
  });

  await test("Grep 单文件 path + 无效正则报错", async () => {
    const r1 = await grep.execute({ pattern: "ALPHA", path: path.join(dir2, "a.ts") });
    assert.ok(r1.content.includes("a.ts:1:"));
    const r2 = await grep.execute({ pattern: "([", path: dir2 });
    assert.ok(r2.isError && r2.content.includes("无效正则"), JSON.stringify(r2));
  });

  await test("loadTranscript: 重放消息树 + 提取用户输入(排除 tool_result/坏行)", async () => {
    const tf = path.join(dir2, "sess.jsonl");
    fs.writeFileSync(
      tf,
      [
        JSON.stringify({ ts: "t1", role: "user", content: [{ type: "text", text: "你好" }] }),
        JSON.stringify({ ts: "t2", role: "assistant", content: [{ type: "text", text: "在" }] }),
        JSON.stringify({ ts: "t3", role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "out" }] }),
        "{bad json line",
        JSON.stringify({ ts: "t4", role: "user", content: [{ type: "text", text: "第二条" }] }),
        "",
      ].join("\n"),
      "utf8"
    );
    const data = loadTranscript(tf);
    assert.strictEqual(data.messages.length, 4, "坏行跳过, 4 条有效消息");
    assert.strictEqual(data.messages[2].content[0].type, "tool_result");
    assert.deepStrictEqual(data.userPrompts, ["你好", "第二条"], "tool_result 行不算用户输入");
  });

  fs.rmSync(dir2, { recursive: true, force: true });

  // ---------- Part 3: AnthropicProvider 假服务端 ----------
  console.log("[3] AnthropicProvider 假服务端");
  const queue = []; // 响应队列: {status, body} 或 {status, sse}(SSE 分块)
  const hits = []; // 收到的请求记录
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const next = queue.shift() || { status: 200, body: {} };
      if (next.sse) {
        res.writeHead(next.status, { "content-type": "text/event-stream" });
        // 分 3 块发送, 模拟 fetch chunk 边界任意切断
        const s = next.sse;
        const cut1 = Math.floor(s.length / 3), cut2 = Math.floor((s.length * 2) / 3);
        res.write(s.slice(0, cut1));
        setTimeout(() => res.write(s.slice(cut1, cut2)), 10);
        setTimeout(() => res.end(s.slice(cut2)), 20);
      } else {
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const mk = (maxRetries = 1) =>
    new AnthropicProvider({ apiKey: "sk-test", baseURL, maxRetries, log: () => {} });

  const SYS = ["你是助手", "规则补充"];
  const MSGS = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  const TOOLS = [{ name: "T1", description: "测试工具", input_schema: { type: "object", properties: {} } }];

  await test("500 → 重试 → 200 成功; 请求体形状 + usage + content 过滤", async () => {
    queue.push(
      { status: 500, body: { error: "internal" } },
      {
        status: 200,
        body: {
          content: [
            { type: "text", text: "ok" },
            { type: "thinking", thinking: "应被过滤" }, // 非 text/tool_use → 过滤
          ],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 128 },
        },
      }
    );
    const r = await mk().complete(SYS, MSGS, { maxTokens: 99, tools: TOOLS });
    assert.strictEqual(hits.length, 2, "应有 2 次请求(500 重试后成功)");
    const { headers, body } = hits[0];
    assert.strictEqual(headers["x-api-key"], "sk-test");
    assert.strictEqual(headers["anthropic-version"], "2023-06-01");
    assert.strictEqual(body.max_tokens, 99);
    assert.deepStrictEqual(body.system, [
      { type: "text", text: "你是助手\n规则补充", cache_control: { type: "ephemeral" } },
    ]);
    assert.deepStrictEqual(body.messages, MSGS);
    assert.deepStrictEqual(body.tools, [{ name: "T1", description: "测试工具", input_schema: { type: "object", properties: {} } }]);
    assert.strictEqual(r.message.content.length, 1);
    assert.strictEqual(r.message.content[0].text, "ok");
    assert.strictEqual(r.usage.input_tokens, 10);
    assert.strictEqual(r.usage.cache_read_input_tokens, 128);
  });

  await test("无 tools 时不传 tools 字段", async () => {
    queue.push({ status: 200, body: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } });
    await mk().complete(SYS, MSGS, { maxTokens: 10 });
    assert.ok(!("tools" in hits[hits.length - 1].body));
  });

  await test("413 → ContextWindowExceededError(接 T5)", async () => {
    queue.push({ status: 413, body: { error: "request too large" } });
    await assert.rejects(() => mk(0).complete(SYS, MSGS, { maxTokens: 10 }), ContextWindowExceededError);
  });

  await test("prompt_too_long 错误文本 → ContextWindowExceededError", async () => {
    queue.push({ status: 400, body: { error: { type: "invalid_request_error", message: "prompt_too_long: tokens exceed" } } });
    await assert.rejects(() => mk(0).complete(SYS, MSGS, { maxTokens: 10 }), ContextWindowExceededError);
  });

  await test("400 普通错误 → 不重试直接抛", async () => {
    const before = hits.length;
    queue.push({ status: 400, body: { error: { type: "invalid_request_error", message: "bad param" } } });
    await assert.rejects(() => mk(1).complete(SYS, MSGS, { maxTokens: 10 }), (e) => {
      assert.ok(!(e instanceof ContextWindowExceededError));
      assert.ok(e.message.includes("400"));
      return true;
    });
    assert.strictEqual(hits.length, before + 1, "400 不可重试, 只应有 1 次请求");
  });

  await test("重试耗尽(500×2, maxRetries=1) → 抛最后一次错误", async () => {
    const before = hits.length;
    queue.push({ status: 500, body: {} }, { status: 500, body: {} });
    await assert.rejects(() => mk(1).complete(SYS, MSGS, { maxTokens: 10 }), (e) => e.message.includes("500"));
    assert.strictEqual(hits.length, before + 2, "应有 2 次请求(初次+1 重试)");
  });

  await test("SSE 流式: text_delta + input_json_delta 聚合 + onTextDelta 顺序", async () => {
    const line = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
    const sse = [
      line({ type: "message_start", message: { usage: { input_tokens: 42 } } }),
      line({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
      line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "！" } }),
      line({ type: "content_block_stop", index: 0 }),
      line({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "Bash" } }),
      line({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls' } }),
      line({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' -la"}' } }),
      line({ type: "content_block_stop", index: 1 }),
      line({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
      line({ type: "message_stop" }),
    ].join("");
    queue.push({ status: 200, sse });
    const deltas = [];
    const r = await mk(0).completeStream(SYS, MSGS, { maxTokens: 10, onTextDelta: (t) => deltas.push(t) });
    assert.deepStrictEqual(deltas, ["你好", "！"], "text delta 按序回调");
    assert.strictEqual(r.message.content[0].text, "你好！");
    const tu = r.message.content[1];
    assert.strictEqual(tu.type, "tool_use");
    assert.deepStrictEqual(tu.input, { command: "ls -la" }, "input_json_delta 分片聚合");
    assert.strictEqual(r.usage.input_tokens, 42);
    assert.strictEqual(r.usage.output_tokens, 7, "output_tokens 取自 message_delta");
    assert.strictEqual(hits[hits.length - 1].body.stream, true, "请求体带 stream: true");
  });

  await test("SSE 413 → ContextWindowExceededError", async () => {
    queue.push({ status: 413, body: {} });
    await assert.rejects(() => mk(0).completeStream(SYS, MSGS, { maxTokens: 10 }), ContextWindowExceededError);
  });

  server.close();

  // ---------- Part 4: Task 子代理 + Plan 模式 ----------
  console.log("[4] Task 子代理 + Plan 模式");

  await test("TaskTool: 派发 → 返回子代理报告; 缺 prompt 报错", async () => {
    const task = new TaskTool(async (prompt, maxTurns) => `报告(${prompt.length}/${maxTurns})`);
    const r = await task.execute({ description: "查", prompt: "调查压缩管线" });
    assert.ok(!r.isError && r.content === "报告(6/12)"), JSON.stringify(r);
    const bad = await task.execute({ description: "x" });
    assert.ok(bad.isError && bad.content.includes("参数错误"));
  });

  await test("createExploreAgent: 独立上下文跑通(Read 工具轮 + 最终报告 + transcript)", async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-task-"));
    const target = path.join(dir3, "target.txt");
    fs.writeFileSync(target, "NEEDLE 内容", "utf8");
    const provider = new MockProvider([
      { toolUses: [{ name: "Read", input: { path: target } }] },
      { text: "调查完成: target.txt 含 NEEDLE" },
    ]);
    const agent = createExploreAgent({
      provider,
      cfg: DEMO_COMPACT_CONFIG,
      rules: { allow: [], deny: [], ask: [] },
      artifactsDir: dir3,
      sessionsDir: dir3,
      cwd: dir3,
      log: () => {},
    });
    const report = await agent("调查 target.txt 的内容");
    assert.ok(report.includes("调查完成") && report.includes("NEEDLE"), report);
    assert.strictEqual(provider.mainCallCount, 2, "子代理两轮(工具调用+总结)");
    const sess = fs.readdirSync(dir3).filter((f) => f.startsWith("sess_task_"));
    assert.strictEqual(sess.length, 1, "独立 transcript");
    const lines = fs.readFileSync(path.join(dir3, sess[0]), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(lines.some((l) => l.role === "user" && l.content[0].type === "text"), "user 指令");
    assert.ok(lines.some((l) => l.role === "assistant" && l.content[0].type === "tool_use"), "工具调用");
    assert.ok(lines.some((l) => l.role === "user" && l.content[0].type === "tool_result"), "工具结果");
    fs.rmSync(dir3, { recursive: true, force: true });
  });

  await test("Plan 模式: Read/只读 Bash 放行, Edit/副作用 Bash 拒绝", async () => {
    const engine = new PermissionEngine({
      rules: { allow: [], deny: [], ask: [] },
      hooks: new HookRunner(parseHookSettings({}), process.cwd(), () => {}),
      provider: new MockProvider([]),
      mode: "plan",
      userResponder: async () => "no",
      session: { sessionId: "s", transcriptPath: "/dev/null", cwd: process.cwd() },
      log: () => {},
    });
    const bash = new BashTool();
    assert.strictEqual((await engine.check(new ReadTool(), { path: "/tmp/x" }, [])).decision, "allow");
    assert.strictEqual((await engine.check(bash, { command: "ls -la" }, [])).decision, "allow");
    const edit = await engine.check(new EditTool(), { path: "/tmp/x", old_string: "a", new_string: "b" }, []);
    assert.strictEqual(edit.decision, "deny");
    assert.strictEqual(edit.source, "plan-mode");
    assert.strictEqual((await engine.check(bash, { command: "npm install" }, [])).decision, "deny");
  });

  // ---------- Part 5: .claudeignore / 并行工具 / 热加载 / MCP ----------
  console.log("[5] .claudeignore / 并行工具 / 热加载 / MCP");

  await test(".claudeignore: Glob/Grep 尊重忽略文件(目录子树 + 文件模式)", async () => {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ignore-"));
    fs.writeFileSync(path.join(dir4, "keep.ts"), "NEEDLE keep\n");
    fs.writeFileSync(path.join(dir4, "skip.log"), "NEEDLE skip\n");
    fs.mkdirSync(path.join(dir4, "build"));
    fs.writeFileSync(path.join(dir4, "build", "b.ts"), "NEEDLE build\n");
    fs.writeFileSync(path.join(dir4, ".claudeignore"), "*.log\nbuild/\n");
    const r1 = await glob.execute({ pattern: "**/*", path: dir4 });
    const files1 = r1.content.split("\n").filter((l) => l && !l.startsWith("(") && !l.startsWith("…"));
    assert.ok(files1.includes("keep.ts") && files1.includes(".claudeignore"), r1.content);
    assert.ok(!files1.includes("skip.log"), "*.log 模式忽略");
    assert.ok(!files1.some((f) => f.startsWith("build/")), "build/ 目录子树忽略");
    const r2 = await grep.execute({ pattern: "NEEDLE", path: dir4 });
    assert.ok(r2.content.includes("keep.ts:1:"));
    assert.ok(!r2.content.includes("skip.log") && !r2.content.includes("build/"), r2.content);
    fs.rmSync(dir4, { recursive: true, force: true });
  });

  await test("并行工具调用: 同轮两个 tool_use 并行执行且结果按序收集", async () => {
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-par-"));
    const f1 = path.join(dir5, "one.txt");
    const f2 = path.join(dir5, "two.txt");
    fs.writeFileSync(f1, "ONE", "utf8");
    fs.writeFileSync(f2, "TWO", "utf8");
    const provider = new MockProvider([
      { toolUses: [{ name: "Read", input: { path: f1 } }, { name: "Read", input: { path: f2 } }] },
      { text: "parallel done" },
    ]);
    const agent = createExploreAgent({
      provider,
      cfg: DEMO_COMPACT_CONFIG,
      rules: { allow: [], deny: [], ask: [] },
      artifactsDir: dir5,
      sessionsDir: dir5,
      cwd: dir5,
      log: () => {},
    });
    const report = await agent("读两个文件");
    assert.ok(report.includes("parallel done"), report);
    const sess = fs.readdirSync(dir5).filter((f) => f.startsWith("sess_task_"));
    const lines = fs.readFileSync(path.join(dir5, sess[0]), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const trMsg = lines.find((l) => l.role === "user" && l.content.some((b) => b.type === "tool_result"));
    assert.strictEqual(trMsg.content.length, 2, "同轮两个 tool_result 同消息收集");
    assert.ok(trMsg.content[0].content.includes("ONE"), "结果按 toolUses 序(保 transcript/cache 稳定)");
    assert.ok(trMsg.content[1].content.includes("TWO"));
    fs.rmSync(dir5, { recursive: true, force: true });
  });

  await test("热加载: engine.updateRules / HookRunner.updateSettings 即时生效", async () => {
    const hooks = new HookRunner(parseHookSettings({}), process.cwd(), () => {});
    const mkEngine = (rules) =>
      new PermissionEngine({
        rules,
        hooks,
        provider: new MockProvider([]),
        mode: "default",
        userResponder: async () => "no",
        session: { sessionId: "s", transcriptPath: "/dev/null", cwd: process.cwd() },
        log: () => {},
      });
    const engine = mkEngine({ allow: [], deny: [], ask: [] });
    const editInput = { path: "/tmp/x", old_string: "a", new_string: "b" };
    assert.strictEqual((await engine.check(new EditTool(), editInput, [])).decision, "deny", "初始无规则 → 弹窗拒绝");
    engine.updateRules({ allow: ["Edit"], deny: [], ask: [] });
    assert.strictEqual((await engine.check(new EditTool(), editInput, [])).decision, "allow", "热加载 allow 规则 → 放行");
    const sessInfo = { sessionId: "s", transcriptPath: "/dev/null", cwd: process.cwd() };
    assert.strictEqual((await hooks.run("PreToolUse", { toolName: "Bash" }, sessInfo)).matched, 0);
    hooks.updateSettings(parseHookSettings({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo ok" }] }] }));
    assert.strictEqual((await hooks.run("PreToolUse", { toolName: "Bash" }, sessInfo)).matched, 1, "热加载 Hook 配置生效");
  });

  await test("MCP: 握手 + tools/list + tools/call + McpTool 包装", async () => {
    const { McpClient } = require("../dist/mcp/client");
    const { McpTool } = require("../dist/mcp/mcpTool");
    const client = new McpClient("echo", { command: "node", args: ["test/mcp-server.js"] }, () => {});
    await client.start();
    const tools = await client.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "echo");
    const r = await client.callTool("echo", { text: "hi" });
    assert.strictEqual(r.text, "echo: hi");
    assert.strictEqual(r.isError, false);
    const wrapped = new McpTool(client, "echo", tools[0]);
    assert.strictEqual(wrapped.name, "mcp__echo__echo");
    assert.deepStrictEqual(wrapped.checkPermissions(), { decision: null }, "MCP 工具不可静态判定 → 走瀑布");
    const er = await wrapped.execute({ text: "yo" });
    assert.strictEqual(er.content, "echo: yo");
    client.stop();
  });

  await test("MCP manager: 注册 mcp__<server>__<tool>; 失败 server 降级跳过", async () => {
    const { connectMcpServers } = require("../dist/mcp/manager");
    const logs = [];
    const m = await connectMcpServers(
      {
        echo: { command: "node", args: ["test/mcp-server.js"] },
        bad: { command: "definitely-not-exist-cmd-xyz" },
      },
      (l) => logs.push(l)
    );
    assert.strictEqual(m.tools.length, 1, "坏 server 降级, 好 server 正常注册");
    assert.strictEqual(m.tools[0].name, "mcp__echo__echo");
    assert.ok(logs.some((l) => l.includes("bad") && l.includes("降级")));
    m.stop();
  });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n冒烟测试全部通过 (${passed}/${passed})`);
})().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
