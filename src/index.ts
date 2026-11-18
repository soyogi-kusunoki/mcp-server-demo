import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  type AuthInfo,
  type McpHandlerRequestOptions,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import type { JWTPayload } from "jose";
import { AUTH_SERVER_URL, MCP_SCOPE, MCP_SERVER_URL } from "./config.js";
import { createServer } from "./server.js";

const mcpUrl = new URL(MCP_SERVER_URL);
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? (mcpUrl.port || 3000));
const MCP_PATH = mcpUrl.pathname;

/** RFC 9728 Protected Resource Metadata の配信パス (リソースのパスを末尾に付ける) */
const PRM_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

// Streamable HTTP ハンドラ。2026-07-28 版プロトコルに加え、
// 2025 年版クライアントにもステートレスに応答する。
const mcpHandler = createMcpHandler(createServer, {
  onerror: (error) => console.error("[mcp]", error),
});

/** 検証済み JWT のクレームを MCP SDK の AuthInfo に変換する */
const toAuthInfo = (request: Request, claims: JWTPayload): AuthInfo => ({
  token: request.headers.get("authorization")?.replace(/^\S+\s+/, "") ?? "",
  clientId: String(claims.azp ?? claims.client_id ?? ""),
  scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
  expiresAt: claims.exp,
  resource: new URL(MCP_SERVER_URL),
  extra: { sub: claims.sub, claims },
});

// Express がパース済みのボディなど、リクエストごとの追加情報を受け渡す
const requestOptions = new WeakMap<Request, McpHandlerRequestOptions | undefined>();

/**
 * アクセストークンを検証してから MCP ハンドラに渡す。
 *
 * - 認証サーバーの JWKS で JWT の署名を検証
 * - iss が認証サーバー、aud がこの MCP サーバーであることを確認
 *   (別のリソース向けに発行されたトークンの流用を防ぐ)
 * - スコープ `mcp:tools` を要求
 * - 未認証なら 401 + `WWW-Authenticate: Bearer resource_metadata="..."` を返し、
 *   クライアントに OAuth フローの開始を促す
 */
const protectedMcp = createMcpProtectedRequestHandler(
  {
    issuer: AUTH_SERVER_URL,
    audience: MCP_SERVER_URL,
    jwksUrl: `${AUTH_SERVER_URL}/api/auth/jwks`,
    requiredScopes: [MCP_SCOPE],
  },
  (request, claims) =>
    mcpHandler.fetch(request, {
      ...requestOptions.get(request),
      authInfo: toAuthInfo(request, claims),
    }),
);

const handleMcp = toNodeHandler(
  {
    fetch: (request, options) => {
      requestOptions.set(request, options);
      return protectedMcp(request);
    },
  },
  { onerror: (error) => console.error("[http]", error) },
);

// localhost にバインドする場合、DNS リバインディング対策として
// Host / Origin ヘッダーの検証が自動で有効になる。JSON ボディのパースも行う。
const app = createMcpExpressApp({ host: HOST });

// Protected Resource Metadata (RFC 9728)。
// MCP クライアントは 401 の WWW-Authenticate からここを辿り、認証サーバーを発見する。
const protectedResourceMetadata = {
  resource: MCP_SERVER_URL,
  authorization_servers: [AUTH_SERVER_URL],
  scopes_supported: [MCP_SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "mcp-server-demo",
};
app.get([PRM_PATH, "/.well-known/oauth-protected-resource"], (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*").json(protectedResourceMetadata);
});

// GET (SSE) / POST / DELETE をすべて MCP ハンドラに渡す
app.all(MCP_PATH, async (req, res) => {
  await handleMcp(req, res, req.body);
});

app.use((_req, res) => {
  res.status(404).type("text/plain").send("Not Found");
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`mcp-server-demo listening on ${MCP_SERVER_URL} (bind ${HOST}:${PORT})`);
  console.log(`  protected resource metadata: ${mcpUrl.origin}${PRM_PATH}`);
  console.log(`  authorization server: ${AUTH_SERVER_URL}`);
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
