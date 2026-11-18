/**
 * OAuth で保護された MCP サーバーに接続するまでの流れを、ブラウザを使わずに一通り実行するデモ。
 *
 *   1. トークン無しで MCP を呼ぶ → 401 + WWW-Authenticate
 *   2. Protected Resource Metadata (RFC 9728) → 認可サーバーを発見
 *   3. Authorization Server Metadata (RFC 8414) を取得
 *   4. Client ID Metadata Document を公開 (client_id = その文書の URL。事前登録は不要)
 *   5. 認可リクエスト (PKCE)。ログイン画面へのフォーム送信をスクリプトで代行し、コールバックで code を受け取る
 *   6. 認可コードをトークンに交換
 *   7. Bearer トークン付きで MCP の initialize / tools/list / tools/call
 *
 * 事前に `npm run auth-server` と `npm start` (または dev 系) を起動しておくこと。
 *   npm run demo
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const USERNAME = process.env.DEMO_USER ?? "demo";
const PASSWORD = process.env.DEMO_PASSWORD ?? "password";
// このスクリプト自身が立てるローカルサーバー。CIMD の文書とコールバックを提供する
const CLIENT_PORT = Number(process.env.DEMO_CLIENT_PORT ?? 8765);
const CLIENT_BASE = `http://localhost:${CLIENT_PORT}`;
const CLIENT_ID = `${CLIENT_BASE}/oauth/client-metadata.json`;
const REDIRECT_URI = `${CLIENT_BASE}/callback`;

/** Client ID Metadata Document。client_id は文書自身の URL と一致させる */
const clientMetadata = {
  client_id: CLIENT_ID,
  client_name: "mcp-server-demo CLI",
  client_uri: CLIENT_BASE,
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const c = {
  step: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let stepNo = 0;
function step(title: string): void {
  stepNo += 1;
  console.log(`\n${c.step(`[${stepNo}] ${title}`)}`);
}
function show(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(`${c.dim(label + ":")} ${text}`);
}
function fail(message: string): never {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// クライアント側のローカルサーバー (CIMD の文書とリダイレクトのコールバック)
// ---------------------------------------------------------------------------

let metadataFetches = 0;
let resolveCallback: (url: URL) => void;
const callbackReceived = new Promise<URL>((resolve) => (resolveCallback = resolve));

const clientServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", CLIENT_BASE);
  if (req.method === "GET" && url.pathname === "/oauth/client-metadata.json") {
    metadataFetches += 1;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=60" });
    res.end(JSON.stringify(clientMetadata));
    return;
  }
  if (req.method === "GET" && url.pathname === "/callback") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("認可が完了しました。このページは閉じて構いません。");
    resolveCallback(url);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve, reject) => {
  clientServer.once("error", (e) => reject(e));
  clientServer.listen(CLIENT_PORT, "127.0.0.1", () => resolve());
}).catch((e: Error) => fail(`ポート ${CLIENT_PORT} で待ち受けできません: ${e.message}`));

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    fail(`JSON ではないレスポンス (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** MCP の JSON-RPC リクエストを送る (JSON / SSE どちらの応答にも対応) */
let rpcId = 0;
async function mcp(token: string | undefined, method: string, params: unknown = {}): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}

async function rpcResult(res: Response): Promise<any> {
  if (!res.ok) fail(`MCP リクエスト失敗: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
        .find((m) => "result" in m || "error" in m)
    : JSON.parse(text);
  if (payload?.error) fail(`JSON-RPC エラー: ${JSON.stringify(payload.error)}`);
  return payload?.result;
}

// ---------------------------------------------------------------------------

step("トークン無しで MCP サーバーにアクセス");
const unauth = await mcp(undefined, "tools/list");
show("status", unauth.status);
const challenge = unauth.headers.get("www-authenticate");
show("WWW-Authenticate", challenge ?? "(none)");
if (unauth.status !== 401 || !challenge) fail("401 と WWW-Authenticate が返るはずです");
const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
if (!resourceMetadataUrl) fail("resource_metadata が WWW-Authenticate に含まれていません");

step("Protected Resource Metadata (RFC 9728) を取得");
show("GET", resourceMetadataUrl);
const prm = await json<{ resource: string; authorization_servers: string[]; scopes_supported?: string[] }>(
  await fetch(resourceMetadataUrl),
);
show("response", prm);
const issuer = prm.authorization_servers[0];
const scope = (prm.scopes_supported ?? []).join(" ");

step("Authorization Server Metadata (RFC 8414) を取得");
const asMetaUrl = `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
show("GET", asMetaUrl);
const asMeta = await json<{
  authorization_endpoint: string;
  token_endpoint: string;
  client_id_metadata_document_supported?: boolean;
}>(await fetch(asMetaUrl));
show("response", asMeta);
if (!asMeta.client_id_metadata_document_supported) {
  fail("認可サーバーが Client ID Metadata Documents に対応していません");
}

step("Client ID Metadata Document を公開");
show("client_id (= 文書の URL)", CLIENT_ID);
show("document", clientMetadata);
show("補足", "事前登録は不要。認可サーバーが client_id の URL から文書を取得してクライアントを検証する");

step("認可リクエスト (PKCE S256) とログイン");
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
const state = randomBytes(16).toString("base64url");
const authParams = {
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  resource: prm.resource,
};
const authorizeUrl = `${asMeta.authorization_endpoint}?${new URLSearchParams(authParams)}`;
show("ブラウザで開く URL", authorizeUrl);
const loginPage = await fetch(authorizeUrl);
show("ログイン画面", `HTTP ${loginPage.status} (${loginPage.headers.get("content-type")})`);
if (!loginPage.ok) fail(await loginPage.text());
show("認可サーバーによる文書の取得", `${metadataFetches} 回 (GET ${CLIENT_ID})`);

show("ログイン", `${USERNAME} / ${"*".repeat(PASSWORD.length)} で「許可する」を送信`);
const consent = await fetch(asMeta.authorization_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...authParams, username: USERNAME, password: PASSWORD, action: "approve" }),
});
// fetch がリダイレクトに従い、ローカルサーバーの /callback に到達する
if (!consent.ok) fail(`認可に失敗しました: HTTP ${consent.status}`);
const callback = await callbackReceived;
show("コールバック", callback.href);
if (callback.searchParams.get("state") !== state) fail("state が一致しません");
const code = callback.searchParams.get("code") ?? fail(`認可エラー: ${callback.searchParams.get("error")}`);

step("認可コードをアクセストークンに交換");
const tokenRes = await fetch(asMeta.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    resource: prm.resource,
  }),
});
const tokens = await json<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>(
  tokenRes,
);
if (!tokenRes.ok) fail(`トークン取得失敗: ${JSON.stringify(tokens)}`);
show("access_token", `${tokens.access_token.slice(0, 12)}… (expires_in=${tokens.expires_in}s, scope=${tokens.scope})`);

step("Bearer トークン付きで MCP を呼び出し");
const init = await rpcResult(
  await mcp(tokens.access_token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "oauth-demo-cli", version: "1.0.0" },
  }),
);
show("initialize → serverInfo", init.serverInfo);

const list = await rpcResult(await mcp(tokens.access_token, "tools/list"));
show("tools/list", list.tools.map((t: { name: string }) => t.name).join(", "));

const whoami = await rpcResult(await mcp(tokens.access_token, "tools/call", { name: "whoami", arguments: {} }));
show("tools/call whoami", whoami.content[0].text);

const hello = await rpcResult(
  await mcp(tokens.access_token, "tools/call", { name: "hello", arguments: { name: USERNAME } }),
);
show("tools/call hello", hello.content[0].text);

step("不正なトークンは拒否される");
const bad = await mcp("invalid-token", "tools/list");
show("status", bad.status);
show("WWW-Authenticate", bad.headers.get("www-authenticate") ?? "(none)");

clientServer.close();
console.log(`\n${c.ok("✓ OAuth フローのデモが完了しました")}`);
