// test/smoke.js — 冒烟测试(不依赖真实 API Key)
// 1) Edit 工具全分支: 先读后改 / 多处匹配 / 唯一替换 / replace_all / 新鲜度校验 / Write 后直接 Edit
// 2) AnthropicProvider 假服务端: 重试矩阵 / 413 与 prompt_too_long → ContextWindowExceededError /
//    请求体形状(cache_control 断点 / tools 透传) / usage 遥测 / content 过滤
// 6) AbortSignal 贯通: Bash 中止 / Provider 中断不重试 / 主循环中断后消息树一致 / 权限弹窗 race
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
const { loadTranscript, repairTranscript } = require("../dist/session/resume");

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
  // ---------- Part 6: AbortSignal 贯通 ----------
  console.log("[6] AbortSignal 贯通");
  const { RunAbortedError } = require("../dist/types");
  const { ToolRegistry } = require("../dist/tools/tool");
  const { initLoopState, runQuery } = require("../dist/query");

  await test("Bash: 预中止 signal → 立即返回 aborted 结果", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const r = await new BashTool().execute({ command: "sleep 3; echo done" }, { signal: ac.signal });
    assert.ok(r.isError && r.content.includes("[aborted by user]"), JSON.stringify(r));
    assert.ok(Date.now() - t0 < 1500, "应立即返回而非等满超时");
  });

  await test("Bash: 执行中 abort → SIGKILL 子进程尽快返回", async () => {
    const ac = new AbortController();
    const p = new BashTool().execute({ command: "sleep 3; echo done" }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await p;
    assert.ok(r.isError && r.content.includes("[aborted by user]"), JSON.stringify(r));
    assert.ok(Date.now() - t0 < 2000, "中止后应尽快返回(而非 3s 跑满)");
  });

  await test("Provider: 外部中断 → RunAbortedError 且不重试", async () => {
    let hits = 0;
    const slow = http.createServer((req, res) => {
      hits++;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [], usage: {} }));
      }, 5000);
    });
    await new Promise((r) => slow.listen(0, "127.0.0.1", r));
    const p = new AnthropicProvider({
      apiKey: "k",
      baseURL: `http://127.0.0.1:${slow.address().port}`,
      maxRetries: 2,
      log: () => {},
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    await assert.rejects(
      () => p.complete(["s"], [{ role: "user", content: [{ type: "text", text: "hi" }] }], { maxTokens: 10, signal: ac.signal }),
      RunAbortedError
    );
    assert.ok(Date.now() - t0 < 2000, "中断应快速生效");
    assert.strictEqual(hits, 1, "中断不触发重试");
    slow.close();
  });

  await test("主循环: 工具执行中 abort → RunAbortedError + 消息树一致(tool_use 有配对结果)", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-abort-"));
    const provider = new MockProvider([
      { toolUses: [{ name: "Bash", input: { command: "sleep 3" } }] },
      { text: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register(new BashTool());
    const noHooks = new HookRunner(parseHookSettings({}), dirA, () => {});
    const sessInfo = { sessionId: "s", transcriptPath: path.join(dirA, "t.jsonl"), cwd: dirA };
    const ac = new AbortController();
    const deps = {
      provider,
      tools,
      permissions: new PermissionEngine({
        rules: { allow: [], deny: [], ask: [] },
        hooks: noHooks,
        provider,
        mode: "bypassPermissions",
        userResponder: async () => "yes",
        session: sessInfo,
        log: () => {},
      }),
      hooks: noHooks,
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: ["test"],
      systemTokens: 1,
      model: "m",
      artifactsDir: dirA,
      session: sessInfo,
      getUserMessages: () => [],
      log: () => {},
      signal: ac.signal,
    };
    const state = initLoopState();
    state.messages.push({ role: "user", content: [{ type: "text", text: "go" }] });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(() => runQuery(deps, state, "user"), RunAbortedError);
    // 消息树一致性: 中断轮的 tool_use 必须有配对 error tool_result(否则对 API 无效)
    const last = state.messages[state.messages.length - 1];
    assert.strictEqual(last.role, "user");
    assert.ok(
      last.content.some((b) => b.type === "tool_result" && b.is_error),
      `中断轮应有 error tool_result: ${JSON.stringify(last.content).slice(0, 200)}`
    );
    fs.rmSync(dirA, { recursive: true, force: true });
  });

  await test("权限弹窗: 永不应答的弹窗 + 中断 → 快速 deny(source=abort)", async () => {
    const engine = new PermissionEngine({
      rules: { allow: [], deny: [], ask: [] },
      hooks: new HookRunner(parseHookSettings({}), process.cwd(), () => {}),
      provider: new MockProvider([]),
      mode: "default",
      userResponder: () => new Promise(() => {}), // 模拟无人应答的浏览器
      session: { sessionId: "s", transcriptPath: "/dev/null", cwd: process.cwd() },
      log: () => {},
    });
    const ac = new AbortController();
    const p = engine.check(new EditTool(), { path: "/tmp/x", old_string: "a", new_string: "b" }, [], ac.signal);
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const outcome = await p;
    assert.strictEqual(outcome.decision, "deny");
    assert.strictEqual(outcome.source, "abort");
    assert.ok(Date.now() - t0 < 2000, "中断应立即解锁权限等待");
  });

  // ---------- Part 7: 并发控制 / 预算熔断 / resume 崩溃修复 ----------
  console.log("[7] 并发控制 / 预算熔断 / resume 崩溃修复");

  await test("文件锁: 同文件并行 Edit 串行化 → 两处编辑都保留(无丢失)", async () => {
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-lock-"));
    const f = path.join(dirC, "same.txt");
    fs.writeFileSync(f, "alpha beta gamma\n", "utf8");
    await read.execute({ path: f }); // 先读后改(两个 Edit 共享同一 Read 快照)
    // 并行两个不同区域的编辑; 无锁时两者都基于旧内容整写 → 后写覆盖先写(丢一处编辑)
    const [r1, r2] = await Promise.all([
      edit.execute({ path: f, old_string: "alpha", new_string: "ALPHA" }),
      edit.execute({ path: f, old_string: "gamma", new_string: "GAMMA" }),
    ]);
    assert.ok(!r1.isError && !r2.isError, `两处编辑都应成功: ${JSON.stringify([r1, r2]).slice(0, 200)}`);
    assert.strictEqual(fs.readFileSync(f, "utf8"), "ALPHA beta GAMMA\n", "两处编辑都应落盘(锁串行化)");
    fs.rmSync(dirC, { recursive: true, force: true });
  });

  await test("并发上限: 同轮 6 个 tool_use → 在飞峰值 = 4(超出排队), 结果按序收集", async () => {
    let active = 0;
    let peak = 0;
    const probe = {
      name: "Probe",
      description: "并发探测",
      inputSchema: { type: "object", properties: {}, required: [] },
      checkPermissions: () => ({ decision: "allow", reason: "probe" }),
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return { content: "ok" };
      },
    };
    const provider = new MockProvider([
      { toolUses: Array.from({ length: 6 }, () => ({ name: "Probe", input: {} })) },
      { text: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register(probe);
    const noHooks = new HookRunner(parseHookSettings({}), os.tmpdir(), () => {});
    const sessInfo = { sessionId: "s", transcriptPath: path.join(os.tmpdir(), `smoke-cap-${Date.now()}.jsonl`), cwd: os.tmpdir() };
    const deps = {
      provider,
      tools,
      permissions: new PermissionEngine({
        rules: { allow: [], deny: [], ask: [] },
        hooks: noHooks,
        provider,
        mode: "bypassPermissions",
        userResponder: async () => "yes",
        session: sessInfo,
        log: () => {},
      }),
      hooks: noHooks,
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: ["test"],
      systemTokens: 1,
      model: "m",
      artifactsDir: os.tmpdir(),
      session: sessInfo,
      getUserMessages: () => [],
      log: () => {},
    };
    const state = initLoopState();
    state.messages.push({ role: "user", content: [{ type: "text", text: "go" }] });
    const out = await runQuery(deps, state, "user");
    assert.strictEqual(peak, 4, `在飞峰值应为并发上限 4(实际 ${peak})`);
    // Stop 轮后树尾是 assistant 文本 → 工具结果在最后一条 user 消息
    const resultsMsg = [...out.messages].reverse().find((m) => m.role === "user");
    assert.strictEqual(resultsMsg.content.filter((b) => b.type === "tool_result").length, 6, "6 个结果按序收集");
  });

  await test("预算熔断: 累计 tokens 超限 → 拒绝下一轮请求(消息树保持一致)", async () => {
    let calls = 0;
    const provider = {
      name: "stub",
      // 每次调用报 200 计费 tokens; 永远发起 tool_use → 循环只能被预算打断
      complete: async () => {
        calls++;
        return {
          message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_b_${calls}`, name: "Bash", input: { command: "echo hi" } }] },
          usage: { input_tokens: 120, output_tokens: 80 },
        };
      },
    };
    const tools = new ToolRegistry();
    tools.register(new BashTool());
    const noHooks = new HookRunner(parseHookSettings({}), os.tmpdir(), () => {});
    const sessInfo = { sessionId: "s", transcriptPath: path.join(os.tmpdir(), `smoke-budget-${Date.now()}.jsonl`), cwd: os.tmpdir() };
    const deps = {
      provider,
      tools,
      permissions: new PermissionEngine({
        rules: { allow: [], deny: [], ask: [] },
        hooks: noHooks,
        provider,
        mode: "bypassPermissions",
        userResponder: async () => "yes",
        session: sessInfo,
        log: () => {},
      }),
      hooks: noHooks,
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: ["test"],
      systemTokens: 1,
      model: "m",
      artifactsDir: os.tmpdir(),
      session: sessInfo,
      getUserMessages: () => [],
      tokenBudget: 250, // 第 2 轮后累计 400 ≥ 250 → 第 3 轮入口熔断
      log: () => {},
    };
    const state = initLoopState();
    state.messages.push({ role: "user", content: [{ type: "text", text: "go" }] });
    await assert.rejects(() => runQuery(deps, state, "user"), /预算熔断/);
    assert.strictEqual(calls, 2, `熔断前应恰好 2 次调用(实际 ${calls})`);
    assert.strictEqual(state.totalTokensUsed, 400, "累计计费 tokens 含全部调用");
    // 熔断发生在轮入口 → 树尾必为完整 tool_result(对 API 有效)
    const last = state.messages[state.messages.length - 1];
    assert.strictEqual(last.role, "user");
    assert.ok(last.content.every((b) => b.type === "tool_result"), "树尾应为完整工具结果消息");
  });

  await test("maxTurns 可配: deps.maxTurns=3 → 第 4 轮前熔断", async () => {
    const provider = new MockProvider(
      Array.from({ length: 5 }, () => ({ toolUses: [{ name: "Bash", input: { command: "echo hi" } }] }))
    );
    const tools = new ToolRegistry();
    tools.register(new BashTool());
    const noHooks = new HookRunner(parseHookSettings({}), os.tmpdir(), () => {});
    const sessInfo = { sessionId: "s", transcriptPath: path.join(os.tmpdir(), `smoke-turns-${Date.now()}.jsonl`), cwd: os.tmpdir() };
    const deps = {
      provider,
      tools,
      permissions: new PermissionEngine({
        rules: { allow: [], deny: [], ask: [] },
        hooks: noHooks,
        provider,
        mode: "bypassPermissions",
        userResponder: async () => "yes",
        session: sessInfo,
        log: () => {},
      }),
      hooks: noHooks,
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: ["test"],
      systemTokens: 1,
      model: "m",
      artifactsDir: os.tmpdir(),
      session: sessInfo,
      getUserMessages: () => [],
      maxTurns: 3,
      log: () => {},
    };
    const state = initLoopState();
    state.messages.push({ role: "user", content: [{ type: "text", text: "go" }] });
    await assert.rejects(() => runQuery(deps, state, "user"), /超过最大轮次守卫\(3/);
    assert.strictEqual(provider.mainCallCount, 3, "恰好在第 3 轮后停止");
  });

  await test("resume 崩溃修复: 尾部孤儿 tool_use → 补 error 结果 + 落盘幂等", async () => {
    const dirD = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-repair-"));
    const tf = path.join(dirD, "crash.jsonl");
    fs.writeFileSync(
      tf,
      [
        JSON.stringify({ ts: "t1", role: "user", content: [{ type: "text", text: "跑一下" }] }),
        // 崩溃: assistant 发起 tool_use 但 tool_result 未落盘
        JSON.stringify({ ts: "t2", role: "assistant", content: [{ type: "tool_use", id: "tu_x", name: "Bash", input: { command: "sleep 99" } }] }),
      ].join("\n") + "\n",
      "utf8"
    );
    const data = loadTranscript(tf);
    const { messages: r1, report } = repairTranscript(tf, data.messages);
    assert.strictEqual(report.filledUses, 1, "应识别 1 个孤儿 tool_use");
    const last = r1[r1.length - 1];
    assert.strictEqual(last.role, "user");
    const fix = last.content.find((b) => b.type === "tool_result");
    assert.ok(fix && fix.tool_use_id === "tu_x" && fix.is_error, "补齐占位 error tool_result");
    // 幂等: 修复已落盘 → 再次 load+repair 无新修复
    const again = repairTranscript(tf, loadTranscript(tf).messages);
    assert.strictEqual(again.report.filledUses, 0, "二次修复应为空(幂等)");
    fs.rmSync(dirD, { recursive: true, force: true });
  });

  await test("resume 崩溃修复: 坏行致孤儿 tool_result → 从内存树剔除", async () => {
    const dirD = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-repair2-"));
    const tf = path.join(dirD, "crash2.jsonl");
    fs.writeFileSync(
      tf,
      [
        JSON.stringify({ ts: "t1", role: "user", content: [{ type: "text", text: "跑一下" }] }),
        "{bad json — assistant 行损坏被跳过",
        // 其 tool_result 变成孤儿(引用不存在的 tool_use → 对 API 无效)
        JSON.stringify({ ts: "t3", role: "user", content: [{ type: "tool_result", tool_use_id: "tu_gone", content: "out" }] }),
      ].join("\n") + "\n",
      "utf8"
    );
    const data = loadTranscript(tf);
    const { messages: r1, report } = repairTranscript(tf, data.messages);
    assert.strictEqual(report.droppedResults, 1, "应剔除 1 个孤儿 tool_result");
    assert.ok(!r1.some((m) => m.content.some((b) => b.type === "tool_result")), "修复后树中无孤儿 tool_result");
    fs.rmSync(dirD, { recursive: true, force: true });
  });

  // ---------- Part 8: API Key Keychain + 错误遥测 ----------
  console.log("[8] API Key Keychain + 错误遥测");

  await test("Keychain: 假 security 二进制 → store/load/delete + 解析顺序 env > Keychain", async () => {
    const dirK = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-key-"));
    const db = path.join(dirK, "db.txt");
    const bin = path.join(dirK, "security");
    // 假 security: add → 追加库文件; find → 打印 key 或退出 44(未找到); delete → 删库
    fs.writeFileSync(
      bin,
      `#!/bin/sh
case "$1" in
  add-generic-password) printf '%s\\n' "$*" > "${db}"; exit 0 ;;
  find-generic-password) if [ -f "${db}" ]; then sed -n 's/.*-w \\([^ ]*\\).*/\\1/p' "${db}"; exit 0; else exit 44; fi ;;
  delete-generic-password) if [ -f "${db}" ]; then rm -f "${db}"; exit 0; else exit 44; fi ;;
esac
exit 1
`,
      "utf8"
    );
    fs.chmodSync(bin, 0o755);
    const { keychainStore, keychainLoad, keychainDelete, resolveApiKey } = require("../dist/credentials/keychain");
    const prevEnv = process.env.ANTHROPIC_API_KEY;
    process.env.SECURITY_BIN = bin; // 测试注入假二进制(不触真实 Keychain)
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.strictEqual(keychainLoad(), null, "初始无存储");
      assert.strictEqual(resolveApiKey(), null, "env 与 Keychain 均无 → null");
      keychainStore("sk-ant-test-123456");
      assert.strictEqual(keychainLoad(), "sk-ant-test-123456", "store 后可 load");
      assert.deepStrictEqual(resolveApiKey(), { apiKey: "sk-ant-test-123456", source: "keychain" });
      process.env.ANTHROPIC_API_KEY = "sk-env-wins"; // env 优先
      assert.deepStrictEqual(resolveApiKey(), { apiKey: "sk-env-wins", source: "env" });
      process.env.ANTHROPIC_API_KEY = ""; // 空串视为未设置(web-smoke 依赖此语义)
      assert.deepStrictEqual(resolveApiKey(), { apiKey: "sk-ant-test-123456", source: "keychain" });
      assert.strictEqual(keychainDelete(), true, "删除成功");
      assert.strictEqual(keychainLoad(), null);
      assert.strictEqual(keychainDelete(), false, "再删 → 无存储 false");
    } finally {
      delete process.env.SECURITY_BIN;
      if (prevEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevEnv;
      fs.rmSync(dirK, { recursive: true, force: true });
    }
  });

  await test("遥测: classifyError 分类(budget/compact/provider/engine, 中断不计)", async () => {
    const { classifyError } = require("../dist/telemetry/telemetry");
    assert.strictEqual(classifyError(new RunAbortedError()), null, "用户中断不算故障");
    assert.strictEqual(classifyError(new Error("token 预算熔断: 400 ≥ 250")), "budget");
    assert.strictEqual(classifyError(new Error("runQuery: 超过最大轮次守卫(200 轮)")), "budget");
    assert.strictEqual(classifyError(new Error("autocompact 熔断: 连续失败 3 次")), "compact");
    assert.strictEqual(classifyError(new Error("blocking 水位: buffer 180000 ≥ 175000, 拒绝继续")), "compact");
    assert.strictEqual(classifyError(new Error("HTTP 529: overloaded_error")), "provider");
    assert.strictEqual(classifyError(new Error("fetch failed: ECONNRESET")), "provider");
    assert.strictEqual(classifyError(new Error("别的什么错了")), "engine");
  });

  await test("遥测: recordError 分类落盘 JSONL + 会话级计数(中断不计)", async () => {
    const dirT = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-telem-"));
    const { Telemetry } = require("../dist/telemetry/telemetry");
    const t = new Telemetry(dirT);
    t.recordError("s1", new Error("token 预算熔断: 1 ≥ 1"));
    assert.strictEqual(t.recordError("s1", new RunAbortedError()), null, "中断返回 null 不计入");
    t.recordError("s2", new Error("HTTP 500"));
    assert.strictEqual(t.errorStats.total, 2);
    assert.strictEqual(t.errorStats.byCategory.budget, 1);
    assert.strictEqual(t.errorStats.byCategory.provider, 1);
    assert.strictEqual(t.sessionErrorCount("s1"), 1);
    assert.strictEqual(t.sessionErrorCount("nope"), 0);
    const lines = fs.readFileSync(t.logFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.strictEqual(lines.length, 2, "两行 JSONL");
    assert.strictEqual(lines[0].category, "budget");
    assert.strictEqual(lines[0].sessionId, "s1");
    assert.ok(lines[0].ts && lines[0].message.includes("预算熔断"), JSON.stringify(lines[0]));
    fs.rmSync(dirT, { recursive: true, force: true });
  });

  await test("遥测: 工具级失败计数(执行失败 + 未知工具; 权限拒绝不计)", async () => {
    const dirT = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-telem2-"));
    const { Telemetry } = require("../dist/telemetry/telemetry");
    const telem = new Telemetry(dirT);
    const provider = new MockProvider([
      {
        toolUses: [
          { name: "Bash", input: { command: "ls /definitely-not-exist-xyz" } }, // 只读白名单放行 → 执行非零退出
          { name: "NoSuchTool", input: {} },                                    // 未知工具
          { name: "Edit", input: { path: "/tmp/x", old_string: "a", new_string: "b" } }, // 权限拒绝(正常工作流)
        ],
      },
      { text: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register(new BashTool());
    tools.register(new EditTool()); // 注册后 Edit 走权限瀑布 → 用户拒绝(而非"未知工具")
    const noHooks = new HookRunner(parseHookSettings({}), dirT, () => {});
    const sessInfo = { sessionId: "s", transcriptPath: path.join(dirT, "t.jsonl"), cwd: dirT };
    const deps = {
      provider,
      tools,
      permissions: new PermissionEngine({
        rules: { allow: [], deny: [], ask: [] },
        hooks: noHooks,
        provider,
        mode: "default",
        userResponder: async () => "no", // Edit → 用户拒绝
        session: sessInfo,
        log: () => {},
      }),
      hooks: noHooks,
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: ["test"],
      systemTokens: 1,
      model: "m",
      artifactsDir: dirT,
      session: sessInfo,
      getUserMessages: () => [],
      telemetry: telem,
      log: () => {},
    };
    const state = initLoopState();
    state.messages.push({ role: "user", content: [{ type: "text", text: "go" }] });
    await runQuery(deps, state, "user");
    assert.strictEqual(telem.errorStats.toolErrors, 2, "执行失败 + 未知工具计数");
    assert.strictEqual(telem.errorStats.total, 0, "权限拒绝/无引擎级异常 → total 0");
    fs.rmSync(dirT, { recursive: true, force: true });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n冒烟测试全部通过 (${passed}/${passed})`);
})().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
