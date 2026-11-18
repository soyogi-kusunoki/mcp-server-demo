# mcp-server-demo

TypeScript で作成する MCP (Model Context Protocol) サーバーのデモです。
[MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) を使い、Streamable HTTP で提供します。

MCP 仕様の [Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization) に沿って
**OAuth 2.1 で保護**されており、デモ用の**簡易認可サーバー**を同梱しています。

## 必要環境

- Node.js 20 以上

## 構成

```
┌──────────────┐  ① POST /mcp (トークン無し) → 401 + WWW-Authenticate   ┌──────────────────────┐
│              │ ─────────────────────────────────────────────────────▶ │  MCP サーバー :3000   │
│              │  ② GET /.well-known/oauth-protected-resource/mcp     │  (Resource Server)    │
│  MCP         │ ─────────────────────────────────────────────────────▶ │                      │
│  クライアント  │  ⑦ POST /mcp  Authorization: Bearer <token>          │                      │
│ (Claude Code │ ─────────────────────────────────────────────────────▶ │                      │
│  Inspector,  │                                                        └──────────┬───────────┘
│  demo CLI)   │  ③ /.well-known/oauth-authorization-server                      │ ⑧ POST /introspect
│              │  ④ client_id = メタデータ文書の URL (CIMD, 事前登録なし)            ▼  (トークン検証)
│              │  ⑤ GET/POST /authorize (ログイン・同意, PKCE)       ┌──────────────────────┐
│              │  ⑥ POST /token  (code → access_token)              │ 認可サーバー :4000     │
│              │ ─────────────────────────────────────────────────▶ │ (Authorization Server)│
│              │                                                    │                      │
│  client_id の │ ◀────────── ⑤' GET <client_id URL> ──────────────── │ 文書を取得して検証     │
│  文書を公開    │       (Client ID Metadata Document)               └──────────────────────┘
└──────────────┘
```

| ファイル | 内容 |
| --- | --- |
| `src/index.ts` | MCP サーバー。Host/Origin 検証、OAuth メタデータ (RFC 9728) の公開、Bearer トークン検証、`/mcp` エンドポイント |
| `src/server.ts` | McpServer のファクトリ (ツール `hello` / `whoami`) |
| `src/auth/verifier.ts` | 認可サーバーの Token Introspection (RFC 7662) でトークンを検証する `OAuthTokenVerifier` |
| `src/auth-server/index.ts` | デモ用の簡易 OAuth 2.1 認可サーバー |
| `src/auth-server/client-metadata.ts` | Client ID Metadata Document の取得・検証・キャッシュ |
| `src/auth-server/store.ts` | 認可コード・トークンのインメモリストア |
| `scripts/demo.ts` | ブラウザ無しで OAuth フロー全体を実行するデモ CLI |

### 認可サーバーが対応している仕様

- RFC 8414 Authorization Server Metadata — `GET /.well-known/oauth-authorization-server`
- [Client ID Metadata Documents](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) (CIMD) —
  メタデータに `client_id_metadata_document_supported: true` を公開。詳細は下記
- Authorization Code Grant + **PKCE (S256 必須)** — `GET/POST /authorize`, `POST /token`
- Refresh Token Grant (ローテーションあり)
- RFC 8707 Resource Indicators — `resource` パラメーターをトークンの audience に設定
- RFC 7662 Token Introspection — `POST /introspect` (MCP サーバー専用、共有シークレットで保護)

### クライアントの識別 (Client ID Metadata Documents)

MCP の最新の認可仕様で非推奨になった RFC 7591 Dynamic Client Registration は実装しておらず、代わりに CIMD を使います。

- クライアントは自身のメタデータ (JSON) を HTTPS の URL で公開し、**その URL を `client_id` として**認可リクエストに使う
- 認可サーバーは `/authorize` の時点でその URL を取得し、次を検証する
  - URL: `https`、パスあり、fragment・認証情報・`.`/`..` セグメントなし
    (デモ用に `http://localhost` / `127.0.0.1` も許可。`ALLOW_INSECURE_CLIENT_ID_URLS=false` で無効化)
  - 文書: `client_id` が URL と一致、`redirect_uris` が 1 件以上、`client_secret` を含まない、
    `token_endpoint_auth_method` は `none` (公開クライアントのみ対応)、16KB 以下、リダイレクトは不可
  - `redirect_uri` が文書の `redirect_uris` に含まれる (loopback の `http` は RFC 8252 に従いポート番号を無視)
- 文書は `Cache-Control: max-age` に従いキャッシュ (既定 5 分、最大 24 時間)
- 同意画面には自称の `client_name` だけでなく `client_id` のホスト名を表示する

`npm run demo` は `http://localhost:8765/oauth/client-metadata.json` で自身の文書を公開し、
`http://localhost:8765/callback` で認可コードを受け取ります。

### MCP サーバー側の処理

- `/mcp` へのリクエストは `requireBearerAuth` (SDK) でトークンを検証
  - トークン無し・無効 → `401` + `WWW-Authenticate: Bearer resource_metadata="…"`
  - スコープ `mcp:tools` 不足 → `403 insufficient_scope`
  - 別リソース向けに発行されたトークン (audience 不一致) → `401`
- `/.well-known/oauth-protected-resource/mcp` で Protected Resource Metadata を公開 (`oauthMetadataResponse`)
- 検証済みのトークン情報はツールから `ctx.http.authInfo` で参照できる (`whoami` ツール参照)

## セットアップ

```bash
npm install
npm run build
```

ターミナルを 2 つ開き、**認可サーバー → MCP サーバー**の順に起動します
(MCP サーバーは起動時に認可サーバーのメタデータを取得します)。

```bash
npm run auth-server
```

```bash
npm start
```

- 認可サーバー: `http://localhost:4000`
- MCP サーバー: `http://localhost:3000/mcp`
- デモユーザー: **`demo` / `password`**

開発中は `npm run dev:auth` と `npm run dev` でウォッチ実行できます。

## デモ

### 1. デモ CLI (ブラウザ不要)

両サーバーを起動した状態で実行すると、401 → ディスカバリー → Client ID Metadata Document の公開 → 認可 (PKCE) →
トークン取得 → ツール呼び出しまでを順に表示します。

```bash
npm run demo
```

### 2. Claude Code / MCP Inspector について

この認可サーバーは CIMD のみに対応しており、DCR (`/register`) はありません。
そのため **CIMD に対応したクライアントのバージョンが必要**です (DCR のみのクライアントは接続できません)。
また、クライアントの文書はインターネット上 (クライアント提供元のサイト) に置かれるため、
認可サーバーを動かしているマシンからその URL にアクセスできる必要があります。

#### Claude Code

```bash
claude mcp add --transport http mcp-server-demo http://localhost:3000/mcp
```

Claude Code 内で `/mcp` を開き `mcp-server-demo` の **Authenticate** を選ぶとブラウザでログイン画面が開きます。
`demo` / `password` でログインして「許可する」を押すと接続され、`whoami` ツールで認証情報を確認できます。

#### MCP Inspector

```bash
npm run inspect
```

Transport に **Streamable HTTP**、URL に `http://localhost:3000/mcp` を指定して接続すると、
401 を受けて OAuth フローが始まりブラウザでログイン画面が開きます (Inspector の Auth 設定画面からも実行できます)。

### curl で確認

```bash
curl -i -X POST http://localhost:3000/mcp
```

```bash
curl http://localhost:3000/.well-known/oauth-protected-resource/mcp
```

## 環境変数

| 変数 | 既定値 | 対象 | 内容 |
| --- | --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | MCP | 待ち受けアドレス |
| `MCP_URL` | `http://localhost:${PORT}/mcp` | MCP | 公開 URL (OAuth の resource 識別子) |
| `AUTH_SERVER_URL` | `http://localhost:4000` | MCP | 認可サーバーの issuer |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `4000` | 認可 | 待ち受けアドレス |
| `AUTH_ISSUER` | `http://localhost:${AUTH_PORT}` | 認可 | issuer URL |
| `MCP_RESOURCE` | `http://localhost:3000/mcp` | 認可 | `resource` 省略時のトークン audience |
| `DEMO_USER` / `DEMO_PASSWORD` | `demo` / `password` | 認可・demo | デモユーザー |
| `ALLOW_INSECURE_CLIENT_ID_URLS` | `true` | 認可 | `http://localhost` などの loopback URL を client_id として許可 |
| `DEMO_CLIENT_PORT` | `8765` | demo | デモ CLI が文書とコールバックを提供するポート |
| `INTROSPECTION_SECRET` | `demo-introspection-secret` | 両方 | introspection の共有シークレット (両サーバーで同じ値にする) |

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `src/` を `build/` にコンパイル |
| `npm start` | ビルド済み MCP サーバーを起動 |
| `npm run auth-server` | ビルド済み認可サーバーを起動 |
| `npm run dev` | tsx で MCP サーバーをウォッチ実行 |
| `npm run dev:auth` | tsx で認可サーバーをウォッチ実行 |
| `npm run demo` | OAuth フローのデモ CLI を実行 |
| `npm run typecheck` | 型チェックのみ実行 |
| `npm run inspect` | MCP Inspector を起動 |

## 注意 (デモ専用)

同梱の認可サーバーは仕組みを理解するための**デモ専用**実装です。本番では使用しないでください。

- データはすべてインメモリ (再起動でトークンは消える。Claude Code 等は再認証が必要)
- ユーザーは固定の 1 名、パスワードは平文で比較
- HTTP で動作 (`dangerouslyAllowInsecureIssuerUrl` を有効化している)
- CIMD 文書の取得先に対する SSRF 対策は最小限 (取得先 IP アドレスの制限などはしていない)
- 同意の記憶、トークン失効 (revocation)、レート制限などは未実装

本番では Auth0 / Keycloak / Entra ID などの認可サーバーを使い、`src/auth/verifier.ts` を
JWT 検証や各サービスの introspection に置き換えてください。

## 使用パッケージ

- `@modelcontextprotocol/server` — MCP サーバー本体 (v2)。`requireBearerAuth` / `oauthMetadataResponse` などの OAuth ヘルパーも利用
- `@modelcontextprotocol/node` — Node.js の `http` 向け Streamable HTTP アダプター
- `zod` — ツール入力スキーマの定義
