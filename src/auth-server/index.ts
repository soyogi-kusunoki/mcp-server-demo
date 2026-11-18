import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { AUTH_SERVER_URL } from "../config.js";
import { auth } from "./auth.js";
import { consentPage, loginPage } from "./pages.js";

const url = new URL(AUTH_SERVER_URL);
const HOST = process.env.AUTH_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AUTH_PORT ?? (url.port || 4000));

const DEMO_USER = {
  name: "Demo User",
  email: "demo@example.com",
  password: "password1234",
};

const app = express();

/** Web 標準の (Request) => Response ハンドラを Express に載せる */
const web = (handler: (request: Request) => Promise<Response>) => toNodeHandler(handler);

// better-auth の API (サインイン, /oauth2/authorize, /oauth2/token, /jwks など)
// express.json() より前にマウントし、ボディは better-auth 側でパースさせる
app.all("/api/auth/*splat", toNodeHandler(auth));

// 認可サーバーメタデータ (RFC 8414) / OIDC Discovery はオリジン直下で配信する
app.get("/.well-known/oauth-authorization-server", web(oauthProviderAuthServerMetadata(auth)));
app.get("/.well-known/openid-configuration", web(oauthProviderOpenIdConfigMetadata(auth)));

app.get("/login", (_req, res) => {
  res.type("html").send(loginPage());
});
app.get("/consent", (_req, res) => {
  res.type("html").send(consentPage());
});
app.get("/", (_req, res) => {
  res.redirect("/.well-known/oauth-authorization-server");
});

app.use((_req, res) => {
  res.status(404).type("text/plain").send("Not Found");
});

// テーブルを作成 (better-auth のスキーマからマイグレーションを生成して適用)
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

// デモユーザーを作成 (既に存在する場合はスキップ)
await auth.api.signUpEmail({ body: DEMO_USER }).catch(() => {});

app.listen(PORT, HOST, () => {
  console.log(`demo auth server listening on ${AUTH_SERVER_URL} (bind ${HOST}:${PORT})`);
  console.log(`  metadata: ${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`);
  console.log(`  demo user: ${DEMO_USER.email} / ${DEMO_USER.password}`);
});
