import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { DatabaseSync } from "node:sqlite";
import { AUTH_SERVER_URL, MCP_SCOPE, MCP_SERVER_URL } from "../config.js";
import { fetchClientMetadataResource } from "./cimd-fetch.js";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  console.warn(
    "[auth] BETTER_AUTH_SECRET が未設定のため、開発用の固定シークレットを使用します",
  );
}

/**
 * デモ用の簡易認証サーバー (better-auth)。
 *
 * - データは node:sqlite のインメモリ DB に保持する (再起動で消える)。
 *   `AUTH_DB_FILE` を指定するとファイルに永続化する
 * - jwt プラグイン: アクセストークンを JWT で発行し、JWKS を公開する
 * - mcp プラグイン: OAuth 2.1 認可サーバー。トークンの aud を MCP サーバーに束縛する
 * - cimd プラグイン: Client ID Metadata Document によるクライアント登録
 *   (Dynamic Client Registration は無効のまま)
 */
export const auth = betterAuth({
  baseURL: AUTH_SERVER_URL,
  basePath: "/api/auth",
  secret: secret ?? "dev-only-secret-change-me-0123456789abcdef",
  database: new DatabaseSync(process.env.AUTH_DB_FILE ?? ":memory:"),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({
      // issuer はオリジンのみとし、RFC 8414 のメタデータを
      // http://localhost:4000/.well-known/oauth-authorization-server で配信する
      jwt: { issuer: AUTH_SERVER_URL },
    }),
    mcp({
      loginPage: "/login",
      consentPage: "/consent",
      resource: MCP_SERVER_URL,
      scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});
