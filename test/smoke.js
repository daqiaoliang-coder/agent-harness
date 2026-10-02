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
const { spawn } = require("child_process");

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
const { buildPermissionPreview, deriveAlwaysRule } = require("../dist/permissions/preview");
const { validateToolInput, formatValidationIssues } = require("../dist/tools/validate");
const { resolveLayerPaths, mergeSettings, loadMergedSettings, composeSystemPrompt, resolveModel } = require("../dist/settings/loader");
const { dispatchSlashCommand, PLAN_MODE_SUFFIX } = require("../dist/commands");
const { createSession, SESSIONS_DIR } = require("../dist/cli");
const { estimateTokens } = require("../dist/context/tokenEstimator");

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

  // ---------- Part 9: 权限弹窗 UX(always 会话记忆 / diff 预览 / fileState 无污染) ----------
  console.log("[9] 权限弹窗 UX: always 记忆 + diff 预览");
  const dirP = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-perm-"));
  const mkPermEngine = (rules, responder) =>
    new PermissionEngine({
      rules,
      hooks: new HookRunner(parseHookSettings({}), dirP, () => {}),
      provider: new MockProvider([]),
      mode: "default",
      userResponder: responder,
      session: { sessionId: "s", transcriptPath: "/dev/null", cwd: dirP },
      log: () => {},
    });
  const bashP = new BashTool();
  const editP = new EditTool();

  await test("always 应答: 推导前缀规则 + 会话内后续免弹窗 + 静态 ask 不被记忆压过", async () => {
    const seen = [];
    const eng = mkPermEngine({ allow: [], deny: [], ask: [] }, async (req) => {
      seen.push(req);
      return seen.length === 1 ? "always" : "no";
    });
    // 兜底弹窗(offerAlways=true) → 选 always → 记住 Bash(git push:*)
    const r1 = await eng.check(bashP, { command: "git push origin main" }, []);
    assert.strictEqual(r1.decision, "allow");
    assert.strictEqual(r1.source, "user");
    assert.ok(r1.reason.includes("会话记忆"), JSON.stringify(r1));
    assert.strictEqual(seen[0].alwaysRule, "Bash(git push:*)");
    assert.strictEqual(seen[0].preview, undefined, "Bash 无 diff 预览");
    // 同前缀新参数 → ⑤' 会话记忆层直接放行, 不再弹窗
    const r2 = await eng.check(bashP, { command: "git push origin other" }, []);
    assert.strictEqual(r2.decision, "allow");
    assert.strictEqual(r2.source, "session-allow");
    assert.strictEqual(seen.length, 1, "第二次不应弹窗");
    // 静态 ask(git push --force)在记忆层之前 → 仍需确认, 且不提供 always 选项
    const r3 = await eng.check(bashP, { command: "git push --force origin main" }, []);
    assert.strictEqual(r3.decision, "deny");
    assert.strictEqual(r3.source, "user");
    assert.strictEqual(seen[1].alwaysRule, undefined, "静态 ask 路径不提供总是允许");
  });

  await test("deny 规则/静态检查不可被记忆压过 + updateRules 热加载不清会话记忆", async () => {
    const eng = mkPermEngine({ allow: [], deny: [], ask: [] }, async () => "always");
    await eng.check(bashP, { command: "git push origin main" }, []); // 建立 sessionAllows
    // 注入 deny 规则(热加载) → ① 层优先于 ⑤'
    eng.updateRules({ allow: [], deny: ["Bash(git push:*)"], ask: [] });
    const r1 = await eng.check(bashP, { command: "git push origin x" }, []);
    assert.strictEqual(r1.decision, "deny");
    assert.strictEqual(r1.source, "rule-deny");
    // 清空规则 → 会话记忆仍在(仅内存态, 热加载只换 rules)
    eng.updateRules({ allow: [], deny: [], ask: [] });
    const r2 = await eng.check(bashP, { command: "git push origin x" }, []);
    assert.strictEqual(r2.source, "session-allow");
    // 静态 deny(rm -rf 复合段)优先于记忆
    const r3 = await eng.check(bashP, { command: "git push || rm -rf /" }, []);
    assert.strictEqual(r3.decision, "deny");
    assert.strictEqual(r3.source, "static");
  });

  await test("Edit 工具级记忆 + 会话记忆压过 settings ask 规则", async () => {
    let calls = 0;
    const eng = mkPermEngine({ allow: [], deny: [], ask: ["Bash(npm test:*)"] }, async () => {
      calls++;
      return "always";
    });
    const f = path.join(dirP, "t3.txt");
    fs.writeFileSync(f, "x\n", "utf8");
    // Edit → 兜底弹窗 → always → 记住工具级 "Edit"(任意参数)
    const e1 = await eng.check(editP, { path: f, old_string: "x", new_string: "y" }, []);
    assert.strictEqual(e1.decision, "allow");
    assert.strictEqual(e1.source, "user");
    const e2 = await eng.check(editP, { path: f, old_string: "y", new_string: "z" }, []);
    assert.strictEqual(e2.source, "session-allow");
    assert.strictEqual(calls, 1, "第二次 Edit 免弹窗");
    // ask 规则命中 → offerAlways=true → always 记住 Bash(npm test:*)
    const b1 = await eng.check(bashP, { command: "npm test" }, []);
    assert.strictEqual(b1.decision, "allow");
    assert.strictEqual(b1.source, "user");
    assert.strictEqual(calls, 2);
    // 同前缀变参 → ⑤'(在 ask 规则之前)放行
    const b2 = await eng.check(bashP, { command: "npm test -- --grep x" }, []);
    assert.strictEqual(b2.source, "session-allow");
    assert.strictEqual(calls, 2, "ask 前缀变参免弹窗");
  });

  await test("复合命令精确记忆 + deriveAlwaysRule 规则推导矩阵", async () => {
    let calls = 0;
    const eng = mkPermEngine({ allow: [], deny: [], ask: [] }, async () => {
      calls++;
      return calls === 1 ? "always" : "no";
    });
    // 复合命令(含 &&)→ 只记完整命令本身(前缀 = 全命令), 不放宽
    await eng.check(bashP, { command: "npm test && git status" }, []);
    assert.strictEqual(calls, 1);
    const r2 = await eng.check(bashP, { command: "npm test && git status" }, []);
    assert.strictEqual(r2.source, "session-allow", "逐字重复命中");
    assert.strictEqual(calls, 1);
    const r3 = await eng.check(bashP, { command: "npm test && git push" }, []);
    assert.strictEqual(r3.decision, "deny", "拼接不同命令不放宽");
    assert.strictEqual(calls, 2, "复合变体必须重新弹窗");
    // 推导矩阵单元断言
    assert.strictEqual(deriveAlwaysRule("Bash", { command: "git push origin main" }), "Bash(git push:*)");
    assert.strictEqual(deriveAlwaysRule("Bash", { command: "ls -la" }), "Bash(ls:*)");
    assert.strictEqual(
      deriveAlwaysRule("Bash", { command: "echo a:b && ls" }),
      "Bash(echo a:b && ls:*)",
      "复合命令含冒号 → :* 后缀防 parseRule 前缀截断"
    );
    assert.strictEqual(deriveAlwaysRule("Edit", { path: "/tmp/x" }), "Edit");
    assert.strictEqual(deriveAlwaysRule("mcp__echo__echo", { text: "hi" }), "mcp__echo__echo");
    assert.strictEqual(deriveAlwaysRule("Bash", { command: "" }), undefined);
  });

  await test("buildPermissionPreview: Edit/Write diff 预览 + 不污染 fileState", async () => {
    const f = path.join(dirP, "p.txt");
    fs.writeFileSync(f, "line1\nline2\nline3\nline4\nline5\n", "utf8");
    // Edit 正常预览: 上下文 + del/add + 无 note
    const pv = buildPermissionPreview("Edit", { path: f, old_string: "line3", new_string: "LINE3" }, dirP);
    assert.strictEqual(pv.type, "edit");
    assert.ok(pv.lines.some((l) => l.op === "del" && l.text === "line3"), JSON.stringify(pv.lines));
    assert.ok(pv.lines.some((l) => l.op === "add" && l.text === "LINE3"));
    assert.ok(pv.lines.filter((l) => l.op === "ctx").length >= 2, "命中前后有上下文行");
    assert.strictEqual(pv.note, undefined);
    // old_string 未找到 → 风险提示(执行将失败)
    const pv2 = buildPermissionPreview("Edit", { path: f, old_string: "zzz", new_string: "x" }, dirP);
    assert.ok(pv2.note.includes("未在文件中找到"), pv2.note);
    // 多处匹配 → 不唯一提示
    const pv3 = buildPermissionPreview("Edit", { path: f, old_string: "line", new_string: "x" }, dirP);
    assert.ok(pv3.note.includes("出现 5 次"), pv3.note);
    // Write 新文件: 全 add + 行数标注(尾换行 → split 出 3 行)
    const f2 = path.join(dirP, "new.txt");
    const pw = buildPermissionPreview("Write", { path: f2, content: "a\nb\n" }, dirP);
    assert.strictEqual(pw.type, "write-new");
    assert.deepStrictEqual(pw.lines.map((l) => l.op), ["add", "add", "add"]);
    // Write 覆盖: 公共前后缀裁剪 + del/add + 行数对比
    const f3 = path.join(dirP, "over.txt");
    fs.writeFileSync(f3, "a\nc\n", "utf8");
    const po = buildPermissionPreview("Write", { path: f3, content: "a\nb\n" }, dirP);
    assert.strictEqual(po.type, "write-overwrite");
    assert.ok(po.lines.some((l) => l.op === "del" && l.text === "c"), JSON.stringify(po.lines));
    assert.ok(po.lines.some((l) => l.op === "add" && l.text === "b"));
    assert.ok(po.note.includes("3 行 → 3 行"), po.note);
    // 非 Edit/Write 工具 / 缺 path → undefined(UI 回落 JSON 渲染)
    assert.strictEqual(buildPermissionPreview("Bash", { command: "ls" }, dirP), undefined);
    assert.strictEqual(buildPermissionPreview("Edit", { old_string: "a" }, dirP), undefined);
    // 无污染: 预览只读文件, Edit 仍要求先 Read(fileState 未被权限层虚假满足)
    const r = await editP.execute({ path: f, old_string: "line3", new_string: "LINE3" });
    assert.ok(r.isError && r.content.includes("has not been read"), JSON.stringify(r));
  });

  fs.rmSync(dirP, { recursive: true, force: true });

  // ---------- Part 10: 工具输入校验(形状校验前置 + 语义修正) ----------
  console.log("[10] 工具输入校验");
  const dirV = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-validate-"));
  const bashV = new BashTool();
  const taskV = new TaskTool(async () => "子代理报告");

  // -- validator 单元: 形状检查(required + 严格 typeof) --
  await test("validator: 合法输入通过(零 issue)", async () => {
    assert.deepStrictEqual(validateToolInput(new WriteTool().inputSchema, { path: "/tmp/a.txt", content: "hi" }), []);
    assert.deepStrictEqual(validateToolInput(bashV.inputSchema, { command: "ls" }), []);
  });

  await test("validator: 必填字段缺失(Write 缺 content — 审计最危险缺口)", async () => {
    const issues = validateToolInput(new WriteTool().inputSchema, { path: "/tmp/a.txt" });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, "content");
    assert.ok(issues[0].problem.includes("必填"), JSON.stringify(issues));
  });

  await test("validator: 严格 typeof(字符串 timeout / 数字 path / 字符串 replace_all 全拒)", async () => {
    const issues1 = validateToolInput(bashV.inputSchema, { command: "ls", timeout: "30000" });
    assert.ok(issues1.length === 1 && issues1[0].field === "timeout" && issues1[0].problem.includes("number"), JSON.stringify(issues1));
    const issues2 = validateToolInput(new ReadTool().inputSchema, { path: 123 });
    assert.ok(issues2.length === 1 && issues2[0].problem.includes("string"), JSON.stringify(issues2));
    const issues3 = validateToolInput(new EditTool().inputSchema, {
      path: "/a", old_string: "x", new_string: "y", replace_all: "true",
    });
    assert.ok(issues3.length === 1 && issues3[0].field === "replace_all" && issues3[0].problem.includes("boolean"), JSON.stringify(issues3));
  });

  await test("validator: input 非对象(null/数组/标量)→ (input) 问题", async () => {
    const s = new WriteTool().inputSchema;
    for (const bad of [null, [1, 2], "str", 42]) {
      const issues = validateToolInput(s, bad);
      assert.ok(issues.length === 1 && issues[0].field === "(input)", JSON.stringify(issues));
    }
  });

  await test("validator: NaN 拒绝(number 须 finite)+ 未声明 type 跳过类型检查", async () => {
    const issues = validateToolInput(bashV.inputSchema, { command: "ls", timeout: NaN });
    assert.ok(issues.length === 1 && issues[0].field === "timeout", JSON.stringify(issues));
    // 未声明 type 的属性(MCP anyOf 复杂形状)→ 只查 required, 不做类型检查
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["a"],
    };
    assert.deepStrictEqual(validateToolInput(schema, { a: "ok", b: { complex: true } }), []);
  });

  await test("format: 未知字段提示 + 参数签名一次给全(模型单轮自修正)", async () => {
    const s = new WriteTool().inputSchema;
    const bad = { path: "/a", cotnent: "typo" }; // content 拼错 → 缺失 + 幻觉字段
    const msg = formatValidationIssues("Write", s, bad, validateToolInput(s, bad));
    assert.ok(msg.startsWith("工具输入校验失败(Write)"), msg);
    assert.ok(msg.includes("content: 必填字段缺失"), msg);
    assert.ok(msg.includes("cotnent") && msg.includes("未知字段"), msg);
    assert.ok(msg.includes("path: string(必填)") && msg.includes("content: string(必填)"), msg);
  });

  // -- 语义修正: 空串/越界(形状合法但值无意义) --
  await test("Bash: 空 command 报错(不再 bash -c '' 静默成功)", async () => {
    const r = await bashV.execute({ command: "   " });
    assert.ok(r.isError && r.content.includes("command 不能为空"), JSON.stringify(r));
  });

  await test("Bash: timeout 越界报错(0/负/超上限, 文案含合法区间)", async () => {
    for (const t of [0, -5, 700000]) {
      const r = await bashV.execute({ command: "echo hi", timeout: t });
      assert.ok(r.isError && r.content.includes("1-600000"), JSON.stringify(r));
    }
  });

  await test("Bash: 合法短 timeout 直调通过(不误伤既有中断测试)", async () => {
    const r = await bashV.execute({ command: "echo ok", timeout: 1500 });
    assert.ok(!r.isError && r.content.includes("ok"), JSON.stringify(r));
  });

  await test("Grep: max_results 非正整数报错(不再假'未找到匹配')", async () => {
    const r = await grep.execute({ pattern: "x", path: dirV, max_results: -1 });
    assert.ok(r.isError && r.content.includes("max_results"), JSON.stringify(r));
  });

  await test("Task: max_turns 越界报错(0/超上限/小数, 文案含区间)", async () => {
    for (const m of [0, 51, 2.5]) {
      const r = await taskV.execute({ description: "d", prompt: "p", max_turns: m });
      assert.ok(r.isError && r.content.includes("1-50"), JSON.stringify(r));
    }
  });

  await test("Write/Read: 空 path 明确报错(替换困惑的 ENOENT)", async () => {
    const r1 = await write.execute({ path: "", content: "x" });
    assert.ok(r1.isError && r1.content.includes("path 不能为空"), JSON.stringify(r1));
    const r2 = await read.execute({ path: "" });
    assert.ok(r2.isError && r2.content.includes("path 不能为空"), JSON.stringify(r2));
  });

  await test("Write: 直调缺 content 报错且不清空既有文件(数据丢失防线)", async () => {
    const fKeep = path.join(dirV, "keep.txt");
    fs.writeFileSync(fKeep, "KEEP ME\n", "utf8");
    const r = await write.execute({ path: fKeep }); // 缺 content → 原实现会静默清空
    assert.ok(r.isError && r.content.includes("content 必须为 string"), JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(fKeep, "utf8"), "KEEP ME\n", "文件未被清空");
  });

  await test("Edit: 直调缺 new_string 报错(不再静默删除); 显式空串仍是合法删除", async () => {
    const fDel = path.join(dirV, "del.txt");
    fs.writeFileSync(fDel, "alpha beta\n", "utf8");
    await read.execute({ path: fDel });
    const r1 = await edit.execute({ path: fDel, old_string: "alpha " }); // 缺 new_string → 原实现会删除匹配
    assert.ok(r1.isError, JSON.stringify(r1));
    assert.strictEqual(fs.readFileSync(fDel, "utf8"), "alpha beta\n", "内容未被删除");
    const r2 = await edit.execute({ path: fDel, old_string: "beta", new_string: "" }); // 显式 "" = 删除语义
    assert.ok(!r2.isError, JSON.stringify(r2));
    assert.strictEqual(fs.readFileSync(fDel, "utf8"), "alpha \n");
  });

  // -- dispatch 集成: 校验先于权限瀑布, 计入 toolErrors(同未知工具口径) --
  await test("dispatch: 坏输入 → isError tool_result, 不进瀑布不跑 PostToolUse, 计入遥测", async () => {
    const { Telemetry } = require("../dist/telemetry/telemetry");
    const telem = new Telemetry(dirV);
    const fBad = path.join(dirV, "victim.txt");
    fs.writeFileSync(fBad, "SAFE\n", "utf8");
    const provider = new MockProvider([
      { toolUses: [{ name: "Write", input: { path: fBad } }] },          // 缺 content → 校验失败
      { toolUses: [{ name: "Bash", input: { command: "date" } }] },      // date 不在白名单 → 正常走弹窗
      { text: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register(new WriteTool());
    tools.register(new BashTool());
    const noHooks = new HookRunner(parseHookSettings({}), dirV, () => {});
    const sessInfo = { sessionId: "sv", transcriptPath: path.join(dirV, "t.jsonl"), cwd: dirV };
    let permCalls = 0;
    const deps = {
      provider,
      tools,
      permissions: new PermissionEngine({
        rules: { allow: [], deny: [], ask: [] },
        hooks: noHooks,
        provider,
        mode: "default",
        userResponder: async () => {
          permCalls++;
          return "yes";
        },
        session: sessInfo,
        log: () => {},
      }),
      hooks: noHooks,
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: ["test"],
      systemTokens: 1,
      model: "m",
      artifactsDir: dirV,
      session: sessInfo,
      getUserMessages: () => [],
      telemetry: telem,
      log: () => {},
    };
    const state = initLoopState();
    state.messages.push({ role: "user", content: [{ type: "text", text: "go" }] });
    await runQuery(deps, state, "user");
    // 坏 Write 被校验拦截: 文件不被清空; 若进了瀑布, Write 静态不放行必弹窗(permCalls 会是 2)
    assert.strictEqual(fs.readFileSync(fBad, "utf8"), "SAFE\n", "校验失败不执行, 文件未被清空");
    assert.strictEqual(permCalls, 1, "仅合法 Bash(date) 弹窗一次(坏输入未触发弹窗)");
    assert.strictEqual(telem.errorStats.toolErrors, 1, "校验失败计入 toolErrors(同未知工具口径)");
    // 消息树: 第一个 tool_result 为校验错误文案(模型可自修正), 第二个为正常输出
    const trs = state.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    assert.ok(trs[0].is_error && trs[0].content.includes("工具输入校验失败(Write)") && trs[0].content.includes("必填"), JSON.stringify(trs[0]));
    assert.ok(!trs[1].is_error && trs[1].content, "date 正常执行");
    fs.rmSync(dirV, { recursive: true, force: true });
  });

  // ---------- Part 11: settings 分层合并(user → project → local)+ 系统提示定制 ----------
  console.log("[11] settings 分层合并");
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-settings-"));

  await test("mergeSettings: 权限规则并集 + mcpServers 按键整体覆盖(异名并集)", async () => {
    const m = mergeSettings([
      {
        path: "user",
        raw: {
          permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
          mcpServers: { echo: { command: "node", args: ["a.js"] }, extra: { command: "x" } },
        },
      },
      { path: "project", raw: { permissions: { allow: ["Bash(ls:*)"], ask: ["Write"] }, mcpServers: { echo: { command: "bun" } } } },
      { path: "local", raw: { permissions: { deny: ["Bash(curl:*)"] } } },
    ]);
    assert.deepStrictEqual(m.rules, { allow: ["Read", "Bash(ls:*)"], deny: ["Bash(rm:*)", "Bash(curl:*)"], ask: ["Write"] });
    assert.deepStrictEqual(m.mcpServers, { echo: { command: "bun" }, extra: { command: "x" } }); // 同名深层整体替换
  });

  await test("mergeSettings: engine/model 标量深层覆盖(undefined 不覆盖)", async () => {
    const m = mergeSettings([
      { path: "user", raw: { engine: { maxTurns: 100, tokenBudget: 1000 }, model: "m-user" } },
      { path: "project", raw: { engine: { maxTurns: 50 } } },
      { path: "local", raw: {} },
    ]);
    assert.deepStrictEqual(m.engine, { maxTurns: 50, tokenBudget: 1000 });
    assert.strictEqual(m.model, "m-user");
  });

  await test("mergeSettings: systemPromptAppend 各层拼接 + composeSystemPrompt 组装序(模式后缀永远最后)", async () => {
    const m = mergeSettings([
      { path: "user", raw: { systemPromptAppend: "用户偏好" } },
      { path: "project", raw: { systemPromptAppend: "项目上下文" } },
      { path: "local", raw: { systemPromptAppend: "本地临时" } },
    ]);
    assert.strictEqual(m.systemPromptAppend, "用户偏好\n\n项目上下文\n\n本地临时");
    const prompt = composeSystemPrompt("BASE", m, { cliAppend: "CLI 追加", modeSuffix: "Plan 模式" });
    assert.strictEqual(prompt, "BASE\n\n用户偏好\n\n项目上下文\n\n本地临时\n\nCLI 追加\n\nPlan 模式");
    assert.strictEqual(composeSystemPrompt("BASE", { systemPromptAppend: "" }), "BASE"); // 无追加段 → 原样基线
  });

  await test("mergeSettings: hooks 按事件键连接(user 先注册先执行)", async () => {
    const m = mergeSettings([
      { path: "user", raw: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "u.sh" }] }] } } },
      {
        path: "project",
        raw: {
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", command: "p.sh" }] }],
            Stop: [{ hooks: [{ type: "command", command: "s.sh" }] }],
          },
        },
      },
    ]);
    assert.deepStrictEqual(m.hookSettings, {
      PreToolUse: [
        { hooks: [{ type: "command", command: "u.sh" }] },
        { hooks: [{ type: "command", command: "p.sh" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "s.sh" }] }],
    });
  });

  await test("mergeSettings: 字段级降级 — 类型错字段忽略+警告, 同层其余字段照常", async () => {
    const m = mergeSettings([
      {
        path: "bad",
        raw: {
          permissions: "x",
          mcpServers: { echo: "not-object" },
          engine: { maxTurns: -5, tokenBudget: "大" },
          model: 42,
          systemPromptAppend: "存活",
        },
      },
    ]);
    assert.deepStrictEqual(m.rules, { allow: [], deny: [], ask: [] });
    assert.deepStrictEqual(m.mcpServers, {});
    assert.deepStrictEqual(m.engine, {});
    assert.strictEqual(m.model, undefined);
    assert.strictEqual(m.systemPromptAppend, "存活");
    const w = m.layers[0].warnings.join("\n");
    assert.ok(
      w.includes("permissions") && w.includes("mcpServers.echo") && w.includes("engine.maxTurns") &&
        w.includes("engine.tokenBudget") && w.includes("model"),
      w
    );
  });

  await test("mergeSettings: 未知顶层字段警告(前向兼容不拒绝)", async () => {
    const m = mergeSettings([{ path: "u", raw: { futureFeature: true, model: "m" } }]);
    assert.strictEqual(m.model, "m");
    assert.ok(m.layers[0].warnings.some((x) => x.includes("futureFeature")));
  });

  await test("loadMergedSettings: AGENT_HARNESS_HOME 重定向 + JSON 坏整层跳过 + 其余层照常", async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-user-"));
    const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-proj-"));
    fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(date:*)"] }, systemPromptAppend: "用户级追加" }));
    fs.mkdirSync(path.join(projRoot, "demo"), { recursive: true });
    fs.writeFileSync(path.join(projRoot, "demo", "settings.json"), "{broken json");
    fs.mkdirSync(path.join(projRoot, ".agent-harness"), { recursive: true });
    fs.writeFileSync(path.join(projRoot, ".agent-harness", "settings.json"), JSON.stringify({ model: "local-model", engine: { maxTurns: 50 } }));
    const savedHome = process.env.AGENT_HARNESS_HOME;
    process.env.AGENT_HARNESS_HOME = userDir;
    try {
      // 数组序即合并序(user → project → local); env AGENT_HARNESS_HOME 优先于 ~
      assert.deepStrictEqual(resolveLayerPaths({ projectRoot: projRoot }), [
        path.join(userDir, "settings.json"),
        path.join(projRoot, "demo", "settings.json"),
        path.join(projRoot, ".agent-harness", "settings.json"),
      ]);
      const lines = [];
      const m = loadMergedSettings({ projectRoot: projRoot, log: (l) => lines.push(l) });
      assert.deepStrictEqual(m.rules, { allow: ["Bash(date:*)"], deny: [], ask: [] }); // user 层规则生效
      assert.strictEqual(m.model, "local-model"); // local 层覆盖
      assert.strictEqual(m.engine.maxTurns, 50);
      assert.strictEqual(m.systemPromptAppend, "用户级追加");
      const proj = m.layers[1]; // project 层: JSON 坏 → 整层跳过 + 警告
      assert.strictEqual(proj.loaded, false);
      assert.ok(proj.warnings.some((x) => x.includes("JSON 解析失败")), JSON.stringify(proj));
      assert.ok(lines.some((l) => l.includes("JSON 解析失败")), "坏层警告经 log 外发");
    } finally {
      if (savedHome === undefined) delete process.env.AGENT_HARNESS_HOME;
      else process.env.AGENT_HARNESS_HOME = savedHome;
      fs.rmSync(userDir, { recursive: true, force: true });
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });

  await test("loadMergedSettings: 全部层缺失 → 空默认 + 一行提示(不再 throw)", async () => {
    const lines = [];
    const m = loadMergedSettings({ userDir: path.join(dirS, "none"), projectRoot: path.join(dirS, "none2"), log: (l) => lines.push(l) });
    assert.deepStrictEqual(m.rules, { allow: [], deny: [], ask: [] });
    assert.deepStrictEqual(m.mcpServers, {});
    assert.strictEqual(m.systemPromptAppend, "");
    assert.ok(lines.some((l) => l.includes("未发现任何 settings")), lines.join("\n"));
  });

  await test("resolveModel: 解析序 env > settings > 内置默认", async () => {
    const saved = process.env.ANTHROPIC_MODEL;
    try {
      process.env.ANTHROPIC_MODEL = "env-model";
      assert.strictEqual(resolveModel({ model: "s-model" }), "env-model");
      delete process.env.ANTHROPIC_MODEL;
      assert.strictEqual(resolveModel({ model: "s-model" }), "s-model");
      assert.strictEqual(resolveModel({}), "claude-sonnet-4-5");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = saved;
    }
  });

  // ---------- Part 12: Slash 命令 + 权限模式运行中切换 ----------
  console.log("[12] Slash 命令 + 模式运行中切换");

  // 命令注册表(纯函数层): fake ctx 收集输出与 setMode 调用
  const mkCmdCtx = (mode = "default") => {
    const out = [];
    const ctx = {
      mode,
      setModeCalls: [],
      getMode: () => ctx.mode,
      setMode: (m) => {
        ctx.setModeCalls.push(m);
        ctx.mode = m;
      },
      status: () => `[status] fake ${ctx.mode}`,
      permissionsSummary: () => "[permissions] fake",
      log: (l) => out.push(l),
      exit: () => out.push("EXIT"),
    };
    return { ctx, out };
  };

  await test("dispatchSlashCommand: 非命令 → false;未知命令拦截报错(不转发 LLM);/exit 走 exit()", async () => {
    const { ctx, out } = mkCmdCtx();
    assert.strictEqual(dispatchSlashCommand("普通消息", ctx), false);
    assert.strictEqual(dispatchSlashCommand("/exit", ctx), true);
    assert.deepStrictEqual(out, ["EXIT"]);
    const { ctx: c2, out: o2 } = mkCmdCtx();
    assert.strictEqual(dispatchSlashCommand("/nope x", c2), true);
    assert.strictEqual(o2.length, 1);
    assert.ok(o2[0].includes("未知命令") && o2[0].includes("/help"), o2[0]);
  });

  await test("/help 列出 5 命令;/status /permissions 输出经 ctx 回流", async () => {
    const { ctx, out } = mkCmdCtx();
    dispatchSlashCommand("/help", ctx);
    const helpText = out.join("\n");
    for (const name of ["help", "status", "mode", "permissions", "exit"]) {
      assert.ok(helpText.includes(`/${name}`), `缺少 /${name}`);
    }
    dispatchSlashCommand("/status", ctx);
    assert.ok(out.some((l) => l.includes("fake default")));
    dispatchSlashCommand("/permissions", ctx);
    assert.ok(out.some((l) => l.includes("[permissions]")));
  });

  await test("/mode: 无参显示当前;非法参数报错;bypassPermissions 需 --dangerous;多空格容错", async () => {
    const { ctx, out } = mkCmdCtx("auto");
    dispatchSlashCommand("/mode", ctx);
    assert.ok(out.some((l) => l.includes("当前: auto") && l.includes("bypassPermissions")), out.join("\n"));
    dispatchSlashCommand("/mode fast", ctx);
    assert.ok(out.some((l) => l.includes("未知模式")), out.join("\n"));
    dispatchSlashCommand("/mode bypassPermissions", ctx); // 无 --dangerous → 拒绝
    assert.deepStrictEqual(ctx.setModeCalls, []);
    assert.ok(out.some((l) => l.includes("--dangerous")));
    dispatchSlashCommand("/mode bypassPermissions --dangerous", ctx);
    assert.deepStrictEqual(ctx.setModeCalls, ["bypassPermissions"]);
    dispatchSlashCommand("/mode   plan  ", ctx); // 多空格 + 尾随空格容错
    assert.deepStrictEqual(ctx.setModeCalls, ["bypassPermissions", "plan"]);
  });

  await test("updateMode: plan 门禁即时生效 + 切回 default 恢复弹窗(不弹窗的切换无感)", async () => {
    const dir12 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-mode-"));
    let asked = 0;
    const eng = new PermissionEngine({
      rules: { allow: [], deny: [], ask: [] },
      hooks: new HookRunner(parseHookSettings({}), dir12, () => {}),
      provider: new MockProvider([]),
      mode: "default",
      userResponder: async () => {
        asked++;
        return "no";
      },
      session: { sessionId: "s", transcriptPath: "/dev/null", cwd: dir12 },
      log: () => {},
    });
    const edit12 = new EditTool();
    const args12 = { path: path.join(dir12, "x"), old_string: "a", new_string: "b" };
    const r1 = await eng.check(edit12, args12, []); // default → 兜底弹窗
    assert.strictEqual(r1.source, "user");
    assert.strictEqual(asked, 1);
    eng.updateMode("plan"); // 切 plan → 同操作立即被门禁拒(不弹窗)
    const r2 = await eng.check(edit12, args12, []);
    assert.strictEqual(r2.decision, "deny");
    assert.strictEqual(r2.source, "plan-mode");
    assert.strictEqual(asked, 1);
    eng.updateMode("default"); // 切回 → 恢复弹窗
    const r3 = await eng.check(edit12, args12, []);
    assert.strictEqual(r3.source, "user");
    assert.strictEqual(asked, 2);
    assert.strictEqual(eng.mode, "default"); // 只读访问器
    fs.rmSync(dir12, { recursive: true, force: true });
  });

  await test("updateMode 不清洗会话记忆 + ruleCounts/sessionAllowCount 访问器", async () => {
    const dir12 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-mode-"));
    let n = 0;
    const eng = new PermissionEngine({
      rules: { allow: [], deny: [], ask: [] },
      hooks: new HookRunner(parseHookSettings({}), dir12, () => {}),
      provider: new MockProvider([]),
      mode: "default",
      userResponder: async () => (++n === 1 ? "always" : "no"),
      session: { sessionId: "s", transcriptPath: "/dev/null", cwd: dir12 },
      log: () => {},
    });
    const bash12 = new BashTool();
    const b1 = await eng.check(bash12, { command: "git push origin main" }, []); // 弹窗 always → 记住
    assert.strictEqual(b1.source, "user");
    eng.updateMode("auto"); // 切 auto → 同前缀命令命中会话记忆层(先于分类器)
    const b2 = await eng.check(bash12, { command: "git push origin x" }, []);
    assert.strictEqual(b2.source, "session-allow");
    assert.strictEqual(eng.sessionAllowCount, 1);
    assert.deepStrictEqual(eng.ruleCounts, { allow: 0, deny: 0, ask: 0 });
    eng.updateRules({ allow: ["Read"], deny: ["Bash(rm:*)"], ask: ["Write"] }); // 热加载后计数实时
    assert.deepStrictEqual(eng.ruleCounts, { allow: 1, deny: 1, ask: 1 });
    fs.rmSync(dir12, { recursive: true, force: true });
  });

  await test("setMode: plan 后缀动态增删 + systemTokens 重算 + mode_changed 事件(双通道即时)", async () => {
    const emitted = [];
    const sid = `sess_smoke_cmd_${Date.now()}`;
    const session = await createSession({
      provider: new MockProvider([]),
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: "BASE-PROMPT",
      rules: { allow: [], deny: [], ask: [] },
      hookSettings: parseHookSettings({}),
      sessionId: sid,
      mode: "default",
      emit: (e) => emitted.push(e),
      userResponder: async () => "no",
    });
    try {
      assert.ok(!session.deps.systemPrompt[0].includes(PLAN_MODE_SUFFIX), "初始 default 无后缀");
      const baseTokens = session.deps.systemTokens;
      session.setMode("plan"); // 切 plan: 后缀出现 + tokens 重算 + 事件
      assert.strictEqual(session.deps.permissions.mode, "plan");
      const withSuffix = session.deps.systemPrompt[0];
      assert.ok(withSuffix.includes("BASE-PROMPT") && withSuffix.includes(PLAN_MODE_SUFFIX), withSuffix);
      assert.strictEqual(session.deps.systemTokens, estimateTokens(withSuffix));
      assert.ok(session.deps.systemTokens > baseTokens, "后缀令牌计入水位");
      assert.ok(emitted.some((e) => e.kind === "mode_changed" && e.mode === "plan"));
      session.setMode("auto"); // 切走: 后缀动态移除(不残留误导模型)
      assert.ok(!session.deps.systemPrompt[0].includes(PLAN_MODE_SUFFIX));
      assert.strictEqual(session.deps.systemTokens, baseTokens);
      assert.ok(emitted.some((e) => e.kind === "mode_changed" && e.mode === "auto"));
    } finally {
      session.close();
      try {
        fs.rmSync(path.join(SESSIONS_DIR, `${sid}.jsonl`), { force: true });
      } catch { /* 空 transcript 可能未落盘 */ }
    }
  });

  await test("createSession(mode plan): 创建即含后缀(启动 --plan 与运行中切换同源)", async () => {
    const sid = `sess_smoke_cmd_p_${Date.now()}`;
    const session = await createSession({
      provider: new MockProvider([]),
      cfg: DEMO_COMPACT_CONFIG,
      systemPrompt: "BASE-PROMPT",
      rules: { allow: [], deny: [], ask: [] },
      hookSettings: parseHookSettings({}),
      sessionId: sid,
      mode: "plan",
      userResponder: async () => "no",
    });
    try {
      assert.strictEqual(session.deps.permissions.mode, "plan");
      assert.ok(session.deps.systemPrompt[0].endsWith(PLAN_MODE_SUFFIX), "后缀拼在提示尾部");
      assert.strictEqual(session.deps.systemTokens, estimateTokens(session.deps.systemPrompt[0]));
    } finally {
      session.close();
      try {
        fs.rmSync(path.join(SESSIONS_DIR, `${sid}.jsonl`), { force: true });
      } catch { /* 同上 */ }
    }
  });

  // ---------- Part 13: Headless 非交互单发(chat -p / stdin 管道 / --output-format) ----------
  //     子进程 spawn + AGENT_HARNESS_MOCK_SCRIPT 显式 mock(防真实 Keychain/用户级 settings 介入:
  //     ANTHROPIC_API_KEY 置空 + NO_KEYCHAIN + AGENT_HARNESS_HOME 指向空临时目录)
  console.log("[13] Headless 非交互单发(chat -p / stdin / output-format)");
  const headlessHome = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-headless-home-"));
  const HEADLESS_ENV = {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    AGENT_HARNESS_NO_KEYCHAIN: "1",
    AGENT_HARNESS_HOME: headlessHome,
  };
  // keepTranscript: 测试需读 transcript 断言时置 true(跳过自动清理, 由测试方 rmTranscript 收尾)
  const headlessRun = (cliArgs, { stdinData, mockScript, keepTranscript } = {}) =>
    new Promise((resolve) => {
      const env = { ...HEADLESS_ENV };
      if (mockScript !== undefined) env.AGENT_HARNESS_MOCK_SCRIPT = JSON.stringify(mockScript);
      // 快照 sessions 目录: 结束后清掉本次 spawn 新建的 sess_chat_*(text 格式拿不到 sessionId, 统一差异清理
      //   防污染开发者 chat --resume 会话列表; smoke 自身会话用 sess_smoke_* 前缀不受影响)
      const before = new Set(fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : []);
      const child = spawn("node", ["dist/cli.js", "chat", ...cliArgs], {
        cwd: path.resolve(__dirname, ".."),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.stdin.end(stdinData);
      const cleanup = () => {
        if (keepTranscript || !fs.existsSync(SESSIONS_DIR)) return;
        for (const f of fs.readdirSync(SESSIONS_DIR)) {
          if (!before.has(f) && f.startsWith("sess_chat_")) {
            fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
          }
        }
      };
      child.on("error", (e) => {
        cleanup();
        resolve({ code: -1, out, err: err + String(e) });
      });
      child.on("close", (code) => {
        cleanup();
        resolve({ code, out, err });
      });
    });
  const rmTranscript = (sid) => {
    try {
      fs.rmSync(path.join(SESSIONS_DIR, `${sid}.jsonl`), { force: true });
    } catch { /* 空 transcript 可能未落盘 */ }
  };

  await test("chat -p 基本链路: 白名单工具放行 → stdout 仅最终文本(日志走 stderr), exit 0", async () => {
    const r = await headlessRun(["-p", "看下目录"], {
      mockScript: [
        { toolUses: [{ name: "Bash", input: { command: "ls -la" } }] },
        { text: "HEADLESS-BASIC-DONE 目录已查看。" },
      ],
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    assert.ok(r.out.includes("HEADLESS-BASIC-DONE"), `stdout: ${r.out}`);
    assert.ok(!r.out.includes("── 用户:"), "stdout 不应混入会话日志");
    assert.ok(r.err.includes("── 用户:"), "进度日志应走 stderr");
    assert.ok(!r.err.includes("自动拒绝"), "白名单工具不应触发自动拒绝");
  });

  await test("无人值守权限: 未命中规则 → 自动拒绝(模型收到拒绝反馈换路继续), exit 0", async () => {
    const r = await headlessRun(["-p", "看下时间", "--permission-mode", "default"], {
      mockScript: [
        { toolUses: [{ name: "Bash", input: { command: "date" } }] },
        { text: "HEADLESS-DENY-DONE 被拒后改由自身知识回答。" },
      ],
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    assert.ok(r.err.includes("[headless] 权限弹窗自动拒绝"), `stderr: ${r.err}`);
    assert.ok(r.err.includes("date"), `stderr: ${r.err}`);
    assert.ok(r.out.includes("HEADLESS-DENY-DONE"), `stdout: ${r.out}`);
  });

  await test("--output-format json: stdout 单行 JSON, 含 result + 全量统计字段", async () => {
    const r = await headlessRun(["-p", "你好", "--output-format", "json"], {
      mockScript: [{ text: "JSON-RESULT-OK" }],
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    const lines = r.out.trim().split("\n");
    assert.strictEqual(lines.length, 1, `stdout 应为单行 JSON: ${r.out}`);
    const j = JSON.parse(lines[0]);
    assert.strictEqual(j.result, "JSON-RESULT-OK");
    assert.ok(j.sessionId.startsWith("sess_chat_"), j.sessionId); // 交互 chat --resume 可续接
    assert.strictEqual(j.mode, "auto");
    assert.strictEqual(j.permissionDenials, 0);
    assert.strictEqual(j.toolUses, 0);
    assert.strictEqual(j.interrupted, false);
    assert.strictEqual(j.errors, 0);
    assert.ok(typeof j.turns === "number" && j.turns >= 1, `turns: ${j.turns}`);
    assert.ok(typeof j.totalTokensUsed === "number");
    rmTranscript(j.sessionId);
  });

  await test("--output-format stream-json: UiEvent 逐行 JSONL + 终行 result 统计", async () => {
    const r = await headlessRun(
      ["-p", "看下时间", "--permission-mode", "default", "--output-format", "stream-json"],
      {
        mockScript: [
          { toolUses: [{ name: "Bash", input: { command: "date" } }] },
          { text: "STREAM-JSON-DONE" },
        ],
      }
    );
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    const evs = r.out.trim().split("\n").map((l) => JSON.parse(l));
    const kinds = new Set(evs.map((e) => e.kind));
    for (const k of ["tool_start", "perm", "tool_result", "assistant_message", "stop", "result"]) {
      assert.ok(kinds.has(k), `缺少事件 ${k}: ${r.out}`);
    }
    const perm = evs.find((e) => e.kind === "perm");
    assert.strictEqual(perm.decision, "deny");
    assert.strictEqual(perm.source, "user");
    const tr = evs.find((e) => e.kind === "tool_result");
    assert.strictEqual(tr.isError, true, "自动拒绝 → error tool_result");
    const res = evs[evs.length - 1];
    assert.strictEqual(res.kind, "result", "终行应为 result");
    assert.strictEqual(res.result, "STREAM-JSON-DONE");
    assert.strictEqual(res.permissionDenials, 1);
    rmTranscript(res.sessionId);
  });

  await test("stdin 附加语义: cat x | chat -p '总结' → prompt = query + stdin 附加上下文", async () => {
    const r = await headlessRun(["-p", "总结这个输入", "--output-format", "json"], {
      stdinData: "LOG-LINE-A\nLOG-LINE-B\n",
      mockScript: [{ text: "APPEND-OK" }],
      keepTranscript: true,
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    const j = JSON.parse(r.out.trim());
    const entries = fs
      .readFileSync(path.join(SESSIONS_DIR, `${j.sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const userEntry = entries.find((e) => e.role === "user");
    assert.ok(userEntry.content[0].text.includes("总结这个输入"), userEntry.content[0].text);
    assert.ok(userEntry.content[0].text.includes("--- stdin 附加内容 ---"), userEntry.content[0].text);
    assert.ok(userEntry.content[0].text.includes("LOG-LINE-A"), userEntry.content[0].text);
    rmTranscript(j.sessionId);
  });

  await test("纯 stdin 提示词: cat x | chat(无 -p) → stdin 全文即提示词", async () => {
    const r = await headlessRun(["--output-format", "json"], {
      stdinData: "直接作为提示词的输入",
      mockScript: [{ text: "STDIN-ONLY-OK" }],
      keepTranscript: true,
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    const j = JSON.parse(r.out.trim());
    assert.strictEqual(j.result, "STDIN-ONLY-OK");
    const entries = fs
      .readFileSync(path.join(SESSIONS_DIR, `${j.sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const userEntry = entries.find((e) => e.role === "user");
    assert.strictEqual(userEntry.content[0].text, "直接作为提示词的输入");
    rmTranscript(j.sessionId);
  });

  await test("--permission-mode plan: Write 被 plan 门禁拒绝(先于弹窗层 → permissionDenials 不计)", async () => {
    const r = await headlessRun(["-p", "写个文件", "--permission-mode", "plan", "--output-format", "json"], {
      mockScript: [
        { toolUses: [{ name: "Write", input: { path: "/tmp/smoke-plan-x", content: "x" } }] },
        { text: "PLAN-MODE-DONE 只读模式无法写入。" },
      ],
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.err}`);
    const j = JSON.parse(r.out.trim());
    assert.strictEqual(j.mode, "plan");
    assert.ok(j.result.includes("PLAN-MODE-DONE"), `result: ${j.result}`);
    assert.strictEqual(j.permissionDenials, 0, "plan 门禁在弹窗层之前, 不计入自动拒绝");
    assert.strictEqual(j.toolUses, 1);
    rmTranscript(j.sessionId);
  });

  await test("exit 1 系统故障: 无 key 无 mock → 报错; --output-format 非法值 → 参数错误", async () => {
    const noKey = await headlessRun(["-p", "hi"]); // env 无 key + 禁 Keychain + 无 mock
    assert.strictEqual(noKey.code, 1);
    assert.ok(noKey.err.includes("headless 需要 API key"), noKey.err);
    const badFmt = await headlessRun(["-p", "hi", "--output-format", "yaml"], {
      mockScript: [{ text: "x" }],
    });
    assert.strictEqual(badFmt.code, 1);
    assert.ok(badFmt.err.includes("--output-format 非法"), badFmt.err);
  });

  fs.rmSync(headlessHome, { recursive: true, force: true });

  fs.rmSync(dirS, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n冒烟测试全部通过 (${passed}/${passed})`);
})().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
