#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "mcp-server-demo",
  version: "1.0.0",
});

// 動作確認用のサンプルツール
server.registerTool(
  "hello",
  {
    title: "Hello",
    description: "指定した名前に挨拶を返します",
    inputSchema: { name: z.string().describe("挨拶する相手の名前") },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `こんにちは、${name}さん！` }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio トランスポートでは stdout が通信に使われるため、ログは stderr に出す
  console.error("mcp-server-demo is running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
