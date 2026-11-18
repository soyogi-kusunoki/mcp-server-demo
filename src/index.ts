import { createServer as createHttpServer } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = "/mcp";

// Streamable HTTP ハンドラ。2026-07-28 版プロトコルに加え、
// 2025 年版クライアントにもステートレスに応答する。
const mcpHandler = createMcpHandler(createServer, {
  onerror: (error) => console.error("[mcp]", error),
});
const handleMcp = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("[http]", error),
});

// DNS リバインディング対策として Host / Origin ヘッダーを localhost に限定する
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createHttpServer(async (req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (pathname !== MCP_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
    return;
  }

  await handleMcp(req, res);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`mcp-server-demo listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
