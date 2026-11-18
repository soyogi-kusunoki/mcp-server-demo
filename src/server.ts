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

  // OAuth で認証されたユーザー・クライアントの情報を返すツール
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "OAuth アクセストークンから認証済みのユーザー・クライアント・スコープを返します",
    },
    async (ctx) => {
      const auth = ctx.http?.authInfo;
      if (!auth) {
        return {
          isError: true,
          content: [{ type: "text", text: "認証情報がありません" }],
        };
      }
      const info = {
        user: auth.extra?.sub ?? null,
        clientId: auth.clientId,
        scopes: auth.scopes,
        resource: auth.resource?.href ?? null,
        expiresAt: auth.expiresAt ? new Date(auth.expiresAt * 1000).toISOString() : null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    },
  );

  return server;
}
