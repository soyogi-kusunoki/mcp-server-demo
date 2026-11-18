import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * MCP サーバーのインスタンスを生成するファクトリ。
 * Streamable HTTP ではリクエストごとに新しいインスタンスが作られるため、
 * ツール・リソース・プロンプトの登録はここにまとめる。
 */
export function createServer(): McpServer {
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
      inputSchema: z.object({
        name: z.string().describe("挨拶する相手の名前"),
      }),
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `こんにちは、${name}さん！` }],
    }),
  );

  return server;
}
