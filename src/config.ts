/**
 * デモ全体で共有する URL 設定。
 *
 * - 認証サーバー (Authorization Server): better-auth で構築 (既定 http://localhost:4000)
 * - MCP サーバー (Protected Resource):   既定 http://localhost:3000/mcp
 *
 * OAuth ではトークンの `iss` / `aud` を URL 文字列で厳密に比較するため、
 * 両サーバーとクライアントで同じ値を参照する。
 */

/** 認証サーバーのオリジン。トークンの `iss` (issuer) にもなる。 */
export const AUTH_SERVER_URL = trimSlash(
  process.env.AUTH_SERVER_URL ?? "http://localhost:4000",
);

/** MCP サーバーのエンドポイント URL。トークンの `aud` (resource) になる。 */
export const MCP_SERVER_URL = trimSlash(
  process.env.MCP_SERVER_URL ?? "http://localhost:3000/mcp",
);

/** MCP サーバーのツール呼び出しに必要なスコープ。 */
export const MCP_SCOPE = "mcp:tools";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
