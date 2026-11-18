/**
 * デモ用の簡易 OAuth 2.1 Authorization Server。
 *
 * 対応している仕様:
 *  - RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server)
 *  - Client ID Metadata Documents (client_id = クライアントのメタデータ文書の URL。事前登録不要)
 *  - Authorization Code Grant + PKCE (S256 必須) (/authorize, /token)
 *  - Refresh Token Grant (ローテーションあり)
 *  - RFC 8707 Resource Indicators (resource パラメーター → トークンの aud)
 *  - RFC 7662 Token Introspection (/introspect, MCP サーバー向け)
 *
 * !!! デモ専用 !!!
 * データはインメモリ、ユーザーは固定の 1 名、HTTP で動作する。本番では使わないこと。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ClientMetadataError,
  isLoopbackHost,
  isRedirectUriAllowed,
  resolveClient,
  type ClientMetadata,
} from "./client-metadata.js";
import { accessTokens, authorizationCodes, randomToken, refreshTokens, s256, safeEqual } from "./store.js";

const HOST = process.env.AUTH_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AUTH_PORT ?? 4000);
const ISSUER = (process.env.AUTH_ISSUER ?? `http://localhost:${PORT}`).replace(/\/$/, "");

/** resource パラメーターが省略されたときにトークンの aud とする MCP サーバー URL */
const DEFAULT_RESOURCE = process.env.MCP_RESOURCE ?? "http://localhost:3000/mcp";

/** MCP サーバーが /introspect を呼ぶときの共有シークレット */
const INTROSPECTION_SECRET = process.env.INTROSPECTION_SECRET ?? "demo-introspection-secret";

/** デモユーザー */
const DEMO_USER = process.env.DEMO_USER ?? "demo";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "password";

const SUPPORTED_SCOPES = ["mcp:tools"];
const DEFAULT_SCOPE = "mcp:tools";
const ACCESS_TOKEN_TTL_SEC = 60 * 60;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  introspection_endpoint: `${ISSUER}/introspect`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
  scopes_supported: SUPPORTED_SCOPES,
  // client_id として Client ID Metadata Document の URL を受け付ける
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  service_documentation: "https://github.com/soyogi-kusunoki/mcp-server-demo",
};

// ---------------------------------------------------------------------------
// HTTP ユーティリティ
// ---------------------------------------------------------------------------

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendOAuthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // クリックジャッキング対策
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  });
  res.end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** application/x-www-form-urlencoded と JSON の両方を受け付ける */
async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    const parsed = raw ? JSON.parse(raw) : {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  url.searchParams.set("iss", ISSUER); // RFC 9207
  res.writeHead(302, { Location: url.toString(), "Cache-Control": "no-store" }).end();
}

// ---------------------------------------------------------------------------
// /authorize — 認可エンドポイント (ログイン + 同意画面)
// ---------------------------------------------------------------------------

interface AuthorizeRequest {
  clientId: string;
  client: ClientMetadata;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
}

type ValidationResult =
  | { ok: true; value: AuthorizeRequest }
  // redirect_uri が信頼できない場合はリダイレクトせずエラー画面を表示する
  | { ok: false; redirect: false; message: string }
  | { ok: false; redirect: true; redirectUri: string; state?: string; error: string; message: string };

async function validateAuthorizeParams(p: Record<string, string | undefined>): Promise<ValidationResult> {
  if (!p.client_id) return { ok: false, redirect: false, message: "client_id is required" };

  // client_id の URL から Client ID Metadata Document を取得して検証する
  let client: ClientMetadata;
  try {
    client = await resolveClient(p.client_id);
  } catch (error) {
    if (error instanceof ClientMetadataError) return { ok: false, redirect: false, message: error.message };
    throw error;
  }

  const redirectUri = p.redirect_uri;
  if (!redirectUri) return { ok: false, redirect: false, message: "redirect_uri is required" };
  if (!isRedirectUriAllowed(client, redirectUri)) {
    return { ok: false, redirect: false, message: "redirect_uri is not listed in the client metadata document" };
  }

  const fail = (error: string, message: string): ValidationResult => ({
    ok: false,
    redirect: true,
    redirectUri,
    state: p.state,
    error,
    message,
  });

  if (p.response_type !== "code") return fail("unsupported_response_type", "response_type must be 'code'");
  if (!p.code_challenge) return fail("invalid_request", "code_challenge is required (PKCE)");
  if ((p.code_challenge_method ?? "plain") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }

  const scopes = (p.scope || DEFAULT_SCOPE).split(" ").filter(Boolean);
  const unknown = scopes.filter((s) => !SUPPORTED_SCOPES.includes(s));
  if (unknown.length > 0) return fail("invalid_scope", `unsupported scope: ${unknown.join(" ")}`);

  let resource = DEFAULT_RESOURCE;
  if (p.resource) {
    try {
      const u = new URL(p.resource);
      if (u.hash) throw new Error();
      resource = p.resource;
    } catch {
      return fail("invalid_target", "resource must be an absolute URI without fragment");
    }
  }

  return {
    ok: true,
    value: { clientId: p.client_id, client, redirectUri, state: p.state, codeChallenge: p.code_challenge, scopes, resource },
  };
}

function renderLoginPage(params: Record<string, string>, req: AuthorizeRequest, errorMessage?: string): string {
  const hidden = Object.entries(params)
    .filter(([k]) => !["username", "password", "action"].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n      ");
  const clientHost = new URL(req.clientId).host;
  const clientName = escapeHtml(req.client.client_name ?? clientHost);
  const clientUri = req.client.client_uri;
  // logo は client_id と同じホストのものだけ表示する (なりすまし対策)
  const logoUri =
    req.client.logo_uri && new URL(req.client.logo_uri).host === clientHost ? req.client.logo_uri : undefined;
  const isLocalApp = isLoopbackHost(new URL(req.redirectUri).hostname);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo Auth Server - ログイン</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f4f5f7; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 28px; width: 100%; max-width: 380px; }
    h1 { font-size: 1.2rem; margin: 0 0 4px; }
    p.sub { color: #555; margin: 0 0 20px; font-size: .9rem; }
    label { display: block; font-size: .85rem; margin: 12px 0 4px; }
    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
    .scopes { background: #f7f7fa; border-radius: 6px; padding: 10px 12px; font-size: .85rem; margin: 16px 0; word-break: break-all; }
    .err { color: #b00020; font-size: .9rem; }
    .logo { border-radius: 8px; margin-bottom: 8px; }
    .client { font-size: .85rem; border: 1px solid #e3e5ea; border-radius: 6px; padding: 10px 12px; word-break: break-all; }
    .client .cid { color: #666; margin-top: 4px; }
    .client .warn { color: #8a5a00; background: #fff6e0; border-radius: 4px; padding: 6px 8px; margin-top: 8px; }
    .row { display: flex; gap: 8px; margin-top: 16px; }
    button { flex: 1; padding: 10px; border: 0; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button.primary { background: #3b5bdb; color: #fff; }
    button.secondary { background: #e9ecef; }
    .hint { color: #888; font-size: .8rem; margin-top: 16px; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/authorize">
    <h1>Demo Auth Server</h1>
    ${logoUri ? `<img class="logo" src="${escapeHtml(logoUri)}" alt="" width="48" height="48">` : ""}
    <p class="sub"><strong>${clientName}</strong> がアクセスを求めています</p>
    <div class="client">
      <div>提供元: <strong>${escapeHtml(clientHost)}</strong>${
        clientUri ? ` (<a href="${escapeHtml(clientUri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clientUri)}</a>)` : ""
      }</div>
      <div class="cid">client_id: <code>${escapeHtml(req.clientId)}</code></div>
      ${isLocalApp ? '<div class="warn">このアプリはお使いの PC 上で動作します。心当たりがない場合は拒否してください。</div>' : ""}
    </div>
    ${errorMessage ? `<p class="err">${escapeHtml(errorMessage)}</p>` : ""}
    <div class="scopes">
      <div>スコープ: <code>${escapeHtml(req.scopes.join(" "))}</code></div>
      <div>リソース: <code>${escapeHtml(req.resource)}</code></div>
    </div>
      ${hidden}
    <label for="username">ユーザー名</label>
    <input id="username" name="username" type="text" autocomplete="username" value="${escapeHtml(DEMO_USER)}" required>
    <label for="password">パスワード</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <div class="row">
      <button class="secondary" type="submit" name="action" value="deny" formnovalidate>拒否</button>
      <button class="primary" type="submit" name="action" value="approve">許可する</button>
    </div>
    <p class="hint">デモユーザー: ${escapeHtml(DEMO_USER)} / ${escapeHtml(DEMO_PASSWORD)}</p>
  </form>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>認可エラー</title></head>
<body style="font-family: system-ui, sans-serif; padding: 24px"><h1>認可エラー</h1><p>${escapeHtml(message)}</p></body></html>`;
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const params =
    req.method === "POST" ? await readParams(req) : Object.fromEntries(url.searchParams.entries());

  const result = await validateAuthorizeParams(params);
  if (!result.ok) {
    if (!result.redirect) return sendHtml(res, 400, renderErrorPage(result.message));
    return redirectWith(res, result.redirectUri, {
      error: result.error,
      error_description: result.message,
      state: result.state,
    });
  }
  const authz = result.value;

  // GET: ログイン + 同意画面を表示
  if (req.method === "GET") return sendHtml(res, 200, renderLoginPage(params, authz));

  // POST: フォーム送信
  if (params.action === "deny") {
    return redirectWith(res, authz.redirectUri, {
      error: "access_denied",
      error_description: "the user denied the request",
      state: authz.state,
    });
  }

  const userOk = safeEqual(params.username ?? "", DEMO_USER);
  const passOk = safeEqual(params.password ?? "", DEMO_PASSWORD);
  if (!userOk || !passOk) {
    return sendHtml(res, 401, renderLoginPage(params, authz, "ユーザー名またはパスワードが違います"));
  }

  const code = randomToken();
  authorizationCodes.set(code, {
    code,
    clientId: authz.clientId,
    redirectUri: authz.redirectUri,
    codeChallenge: authz.codeChallenge,
    scopes: authz.scopes,
    resource: authz.resource,
    sub: DEMO_USER,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  console.log(`[auth] user '${DEMO_USER}' approved client ${authz.clientId}`);
  redirectWith(res, authz.redirectUri, { code, state: authz.state });
}

// ---------------------------------------------------------------------------
// /token — トークンエンドポイント
// ---------------------------------------------------------------------------

function issueTokens(clientId: string, scopes: string[], resource: string | undefined, sub: string) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC;
  accessTokens.set(accessToken, { token: accessToken, clientId, scopes, resource, sub, expiresAt });
  refreshTokens.set(refreshToken, { token: refreshToken, clientId, scopes, resource, sub });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const p = await readParams(req);
  // 公開クライアントなのでクライアント認証は無し。認可コード/リフレッシュトークンの発行先 client_id と照合する
  const clientId = p.client_id;
  if (!clientId) return sendOAuthError(res, 401, "invalid_client", "client_id is required");

  if (p.grant_type === "authorization_code") {
    const record = p.code ? authorizationCodes.get(p.code) : undefined;
    // 認可コードは 1 回限り。検証前に削除しておく
    if (record) authorizationCodes.delete(record.code);

    if (!record || record.expiresAt < Date.now()) {
      return sendOAuthError(res, 400, "invalid_grant", "authorization code is invalid or expired");
    }
    if (record.clientId !== clientId) {
      return sendOAuthError(res, 400, "invalid_grant", "authorization code was issued to another client");
    }
    if (p.redirect_uri !== record.redirectUri) {
      return sendOAuthError(res, 400, "invalid_grant", "redirect_uri mismatch");
    }
    if (!p.code_verifier || !safeEqual(s256(p.code_verifier), record.codeChallenge)) {
      return sendOAuthError(res, 400, "invalid_grant", "PKCE verification failed");
    }
    if (p.resource && p.resource !== record.resource) {
      return sendOAuthError(res, 400, "invalid_target", "resource does not match the authorization request");
    }
    console.log(`[auth] issued tokens to client ${clientId}`);
    return sendJson(res, 200, issueTokens(clientId, record.scopes, record.resource, record.sub));
  }

  if (p.grant_type === "refresh_token") {
    const record = p.refresh_token ? refreshTokens.get(p.refresh_token) : undefined;
    if (!record || record.clientId !== clientId) {
      return sendOAuthError(res, 400, "invalid_grant", "refresh token is invalid");
    }
    if (p.resource && p.resource !== record.resource) {
      return sendOAuthError(res, 400, "invalid_target", "resource does not match the original grant");
    }
    let scopes = record.scopes;
    if (p.scope) {
      scopes = p.scope.split(" ").filter(Boolean);
      if (!scopes.every((s) => record.scopes.includes(s))) {
        return sendOAuthError(res, 400, "invalid_scope", "requested scope exceeds the original grant");
      }
    }
    // リフレッシュトークンのローテーション (公開クライアント向け、OAuth 2.1)
    refreshTokens.delete(record.token);
    console.log(`[auth] refreshed tokens for client ${clientId}`);
    return sendJson(res, 200, issueTokens(clientId, scopes, record.resource, record.sub));
  }

  sendOAuthError(res, 400, "unsupported_grant_type", `unsupported grant_type: ${p.grant_type ?? "(none)"}`);
}

// ---------------------------------------------------------------------------
// /introspect — Token Introspection (RFC 7662), MCP サーバー専用
// ---------------------------------------------------------------------------

function isIntrospectionAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() === "basic" && value) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const secret = decoded.slice(decoded.indexOf(":") + 1);
    return safeEqual(secret, INTROSPECTION_SECRET);
  }
  if (scheme?.toLowerCase() === "bearer" && value) return safeEqual(value, INTROSPECTION_SECRET);
  return false;
}

async function handleIntrospect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isIntrospectionAuthorized(req)) {
    return sendJson(res, 401, { error: "invalid_client" }, { "WWW-Authenticate": 'Basic realm="introspect"' });
  }
  const p = await readParams(req);
  const record = p.token ? accessTokens.get(p.token) : undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!record || record.expiresAt <= now) {
    if (record) accessTokens.delete(record.token);
    return sendJson(res, 200, { active: false });
  }
  sendJson(res, 200, {
    active: true,
    client_id: record.clientId,
    scope: record.scopes.join(" "),
    token_type: "Bearer",
    exp: record.expiresAt,
    sub: record.sub,
    aud: record.resource,
    iss: ISSUER,
  });
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  const route = `${req.method} ${url.pathname}`;

  // ブラウザ上のクライアント (MCP Inspector など) から呼ばれるエンドポイントは CORS を許可
  if (url.pathname !== "/authorize") setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    switch (route) {
      case "GET /.well-known/oauth-authorization-server":
      case "GET /.well-known/openid-configuration":
        return sendJson(res, 200, metadata, { "Cache-Control": "max-age=60" });
      case "GET /authorize":
      case "POST /authorize":
        return await handleAuthorize(req, res, url);
      case "POST /token":
        return await handleToken(req, res);
      case "POST /introspect":
        return await handleIntrospect(req, res);
      case "GET /":
        return sendJson(res, 200, { name: "demo-auth-server", metadata: `${ISSUER}/.well-known/oauth-authorization-server` });
      default:
        return sendJson(res, 404, { error: "not_found" });
    }
  } catch (error) {
    console.error("[auth]", error);
    if (!res.headersSent) sendOAuthError(res, 500, "server_error", "internal error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`demo auth server listening on http://${HOST}:${PORT} (issuer: ${ISSUER})`);
  console.log(`  demo user: ${DEMO_USER} / ${DEMO_PASSWORD}`);
  console.log("  ※ デモ専用: データはインメモリで、再起動するとトークンは消えます");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
