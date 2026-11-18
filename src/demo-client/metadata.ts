/**
 * デモクライアントの Client ID Metadata Document (CIMD)。
 *
 * CIMD では「クライアント ID = メタデータ文書の HTTPS URL」となり、
 * 認証サーバーはその URL から下記 JSON を取得してクライアントを登録する。
 * 事前登録 (静的登録) も Dynamic Client Registration も不要になるのが利点。
 *
 * 本来この JSON はクライアント開発者が `DEMO_CLIENT_ID` の URL で公開する。
 * ローカルデモでは公開ホスティングが無いため、認証サーバー側の取得処理が
 * この URL に限って本モジュールの内容を返す (src/auth-server/cimd-fetch.ts)。
 */

/** デモクライアントのコールバック受付ポート */
export const DEMO_CLIENT_CALLBACK_PORT = Number(
  process.env.DEMO_CLIENT_CALLBACK_PORT ?? 8090,
);

export const DEMO_CLIENT_REDIRECT_URI = `http://127.0.0.1:${DEMO_CLIENT_CALLBACK_PORT}/callback`;

/**
 * クライアント ID (= メタデータ文書の URL)。
 * CIMD の仕様上、HTTPS かつ公開ホストでパスを含む URL である必要がある。
 */
export const DEMO_CLIENT_ID =
  process.env.DEMO_CLIENT_ID ??
  "https://mcp-demo-client.example.com/oauth/client-metadata.json";

export const demoClientMetadata = {
  client_id: DEMO_CLIENT_ID,
  client_name: "MCP Demo CLI Client",
  client_uri: new URL("/", DEMO_CLIENT_ID).toString(),
  redirect_uris: [DEMO_CLIENT_REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  // ネイティブ/CLI アプリはシークレットを安全に保持できないため public client (PKCE 必須)
  token_endpoint_auth_method: "none",
} as const;
