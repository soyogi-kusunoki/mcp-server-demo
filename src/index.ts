import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
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

// localhost にバインドする場合、DNS リバインディング対策として
// Host / Origin ヘッダーの検証が自動で有効になる。JSON ボディのパースも行う。
const app = createMcpExpressApp({ host: HOST });

// GET (SSE) / POST / DELETE をすべて MCP ハンドラに渡す
app.all(MCP_PATH, async (req, res) => {
  await handleMcp(req, res, req.body);
});

app.use((_req, res) => {
  res.status(404).type("text/plain").send("Not Found");
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`mcp-server-demo listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
