// 极简 MCP server fixture(smoke 测试用): stdin/stdout 按行交换 JSON-RPC 2.0
// 支持 initialize / tools/list / tools/call(echo 工具)
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id == null) return; // 通知忽略
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-srv", version: "1.0" } };
  } else if (msg.method === "tools/list") {
    result = {
      tools: [
        {
          name: "echo",
          description: "回声工具",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
    };
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "fail") {
      result = { content: [{ type: "text", text: "boom" }], isError: true };
    } else {
      result = { content: [{ type: "text", text: `echo: ${msg.params.arguments.text}` }] };
    }
  } else {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});
