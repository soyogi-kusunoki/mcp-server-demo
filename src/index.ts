import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { createIntrospectionVerifier } from "./auth/verifier.js";
import { createServer } from "./server.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = "/mcp";

/** この MCP サーバーの公開 URL。OAuth の resource 識別子 (RFC 8707) としても使う */
const MCP_URL = new URL(process.env.MCP_URL ?? `http://localhost:${PORT}${MCP_PATH}`);
/** 認可サーバーの issuer URL */
const AUTH_SERVER_URL = (process.env.AUTH_SERVER_URL ?? "http://localhost:4000").replace(/\/$/, "");
/** 認可サーバーの introspection エンドポイントを呼ぶための共有シークレット */
const INTROSPECTION_SECRET = process.env.INTROSPECTION_SECRET ?? "demo-introspection-secret";
/** ツール利用に必要なスコープ */
const REQUIRED_SCOPES = ["mcp:tools"];

// ---------------------------------------------------------------------------
// 認可サーバーのメタデータ取得 (RFC 8414)
// ---------------------------------------------------------------------------

async function fetchAuthServerMetadata(): Promise<OAuthMetadata> {
  const url = `${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as OAuthMetadata;
  } catch (error) {
    console.error(`認可サーバーのメタデータを取得できませんでした: ${url}`);
    console.error(`先に認可サーバーを起動してください (npm run auth-server)。原因: ${(error as Error).message}`);
    process.exit(1);
  }
}

const oauthMetadata = await fetchAuthServerMetadata();
const introspectionEndpoint =
  (oauthMetadata as OAuthMetadata & { introspection_endpoint?: string }).introspection_endpoint ??
  `${AUTH_SERVER_URL}/introspect`;

const metadataOptions: AuthMetadataOptions = {
  oauthMetadata,
  resourceServerUrl: MCP_URL,
  scopesSupported: REQUIRED_SCOPES,
  resourceName: "mcp-server-demo",
  // localhost の HTTP issuer を許可する (デモ専用。本番では HTTPS を使うこと)
  dangerouslyAllowInsecureIssuerUrl: true,
};

/** RFC 9728 Protected Resource Metadata の URL (401 の WWW-Authenticate で通知する) */
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(MCP_URL);

// Bearer トークン検証ゲート: トークン無し/無効 → 401、スコープ不足 → 403
const bearerGate = requireBearerAuth({
  verifier: createIntrospectionVerifier({
    introspectionEndpoint,
    clientSecret: INTROSPECTION_SECRET,
  }),
  requiredScopes: REQUIRED_SCOPES,
  resourceMetadataUrl,
  expectedResource: MCP_URL,
});

// ---------------------------------------------------------------------------
// MCP ハンドラ
// ---------------------------------------------------------------------------

// Streamable HTTP ハンドラ。2026-07-28 版プロトコルに加え、
// 2025 年版クライアントにもステートレスに応答する。
const mcpHandler = createMcpHandler(createServer, {
  onerror: (error) => console.error("[mcp]", error),
});
// req.auth に入れた AuthInfo はツールハンドラから ctx.http.authInfo で参照できる
const handleMcp = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("[http]", error),
});

// DNS リバインディング対策として Host / Origin ヘッダーを localhost に限定する
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

/** Node の IncomingMessage からボディ無しの Web 標準 Request を作る (ヘッダー確認用) */
function toHeaderOnlyRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  // ボディは読まない (Node のストリームは後段の MCP ハンドラが消費する)
  return new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), {
    method: req.method ?? "GET",
    headers,
  });
}

/** Web 標準 Response を Node の ServerResponse に書き出す */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const httpServer = createHttpServer(async (req: IncomingMessage & { auth?: AuthInfo }, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // OAuth ディスカバリー用の well-known (認証不要)
  //  - /.well-known/oauth-protected-resource/mcp  (RFC 9728)
  //  - /.well-known/oauth-authorization-server    (RFC 8414, 旧クライアント向け)
  if (pathname.startsWith("/.well-known/")) {
    const metadataResponse = oauthMetadataResponse(toHeaderOnlyRequest(req), metadataOptions);
    if (metadataResponse) return writeResponse(res, metadataResponse);
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
    return;
  }

  if (pathname !== MCP_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
    return;
  }

  // Bearer トークン検証 (ボディは読まないのでヘッダーのみの Request で十分)
  const auth = await bearerGate(toHeaderOnlyRequest(req));
  if (auth instanceof Response) {
    console.log(`[auth] rejected ${req.method} ${pathname}: HTTP ${auth.status}`);
    return writeResponse(res, auth);
  }

  req.auth = auth;
  await handleMcp(req, res);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`mcp-server-demo listening on http://${HOST}:${PORT}${MCP_PATH}`);
  console.log(`  resource:            ${MCP_URL.href}`);
  console.log(`  resource metadata:   ${resourceMetadataUrl}`);
  console.log(`  authorization server: ${oauthMetadata.issuer}`);
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
