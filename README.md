# mcp-server-demo

TypeScript で作成する MCP (Model Context Protocol) サーバーのデモです。
[MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) を使い、Streamable HTTP で提供します。

MCP サーバーは OAuth 2.1 で保護されています。認可サーバーには
[better-auth](https://www.better-auth.com) で作った簡易的な認証サーバーを使い、
クライアント登録は **CIMD (Client ID Metadata Document)** で行います。

## 必要環境

- Node.js 22.13 以上 (認証サーバーが `node:sqlite` を使うため)

## 構成

OAuth フローの流れ:

1. クライアントがトークンなしで `POST /mcp` → MCP サーバーが `401` と `WWW-Authenticate` を返す
2. クライアントが MCP サーバーの Protected Resource Metadata を取得し、認証サーバーの場所を知る
3. クライアントが認証サーバーのメタデータを取得し、CIMD 対応 (`client_id_metadata_document_supported: true`) を確認
4. クライアントが `client_id` にメタデータ文書の URL を指定して認可リクエストを送る (PKCE + `resource` 指定)
5. 認証サーバーが `client_id` の URL からメタデータ文書を取得・検証し、クライアントを登録 (CIMD)
6. ユーザーがログイン → 同意 → 認可コードがクライアントに返り、トークンに交換される
7. クライアントが Bearer トークン付きで `POST /mcp` → MCP サーバーが JWT を検証してツールを実行

| 役割 | URL | 実装 |
| --- | --- | --- |
| MCP サーバー (Protected Resource) | `http://localhost:3000/mcp` | `src/index.ts`, `src/server.ts` |
| 認証サーバー (Authorization Server) | `http://localhost:4000` | `src/auth-server/` |
| デモクライアント (CLI) | コールバック `http://127.0.0.1:8090/callback` | `src/demo-client/` |

### MCP サーバー

- 未認証のリクエストには `401` と `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:tools"` を返す
- `/.well-known/oauth-protected-resource/mcp` で Protected Resource Metadata (RFC 9728) を公開し、認証サーバーの場所を知らせる
- アクセストークン (JWT) を `@better-auth/mcp` の `createMcpProtectedRequestHandler` で検証する
  - 認証サーバーの JWKS で署名を検証
  - `iss` が認証サーバー、`aud` がこの MCP サーバー (`http://localhost:3000/mcp`) であることを確認 (RFC 8707)
  - スコープ `mcp:tools` が無ければ `403 insufficient_scope`
- `whoami` ツールで、トークンから得たユーザー ID・クライアント ID・スコープを確認できる

### 認証サーバー (better-auth)

| プラグイン | 役割 |
| --- | --- |
| `jwt` (better-auth) | アクセストークンを JWT で発行し、`/api/auth/jwks` で公開鍵を公開 |
| `mcp` (`@better-auth/mcp`) | OAuth 2.1 認可サーバー。トークンを MCP サーバーのリソースに束縛 |
| `cimd` (`@better-auth/cimd`) | CIMD によるクライアント登録 (`metadataProfile: "mcp-2026-07-28"`) |

- データは `node:sqlite` のインメモリ DB に保持します (再起動で消えます)。`AUTH_DB_FILE=auth.db` でファイルに永続化できます
- 起動時にデモユーザー `demo@example.com` / `password1234` を作成します
- Dynamic Client Registration (DCR) は無効です。クライアントは CIMD のみで登録されます

### CIMD (Client ID Metadata Document) について

CIMD では **クライアント ID = クライアントのメタデータ文書 (JSON) を置いた HTTPS URL** です。
認証サーバーは認可リクエストで初めて見る `client_id` を受け取ると、その URL から文書を取得・検証してクライアントを登録します。
事前登録も DCR も不要で、文書を公開しているドメインがクライアントの身元を表します。

デモクライアントのメタデータ文書 (`src/demo-client/metadata.ts`):

```json
{
  "client_id": "https://mcp-demo-client.example.com/oauth/client-metadata.json",
  "client_name": "MCP Demo CLI Client",
  "client_uri": "https://mcp-demo-client.example.com/",
  "redirect_uris": ["http://127.0.0.1:8090/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

> [!NOTE]
> CIMD の `client_id` は公開ホストの HTTPS URL でなければならず、`localhost` などは仕様上使えません。
> ローカルデモでは公開ホスティングを用意しなくて済むよう、認証サーバーの取得処理
> (`src/auth-server/cimd-fetch.ts`) が **デモクライアントの URL に限って** ネットワークに出ずに手元の文書を返します。
> それ以外の `client_id` は `@better-auth/cimd/node` の SSRF 対策済みトランスポートで実際に取得するため、
> メタデータ文書を公開している実クライアントもそのまま使えます。
> 本番では `CIMD_DEMO_CLIENT=false` にするか、この分岐を削除してください。

## セットアップとデモ

```bash
npm install
```

ターミナルを 3 つ開き、それぞれで実行します。

```bash
npm run dev:auth
```

```bash
npm run dev
```

```bash
npm run demo:client
```

デモクライアントを実行するとブラウザで認証サーバーのログイン画面が開きます (開かない場合は表示された URL を開いてください)。

1. ログイン画面: デモユーザー (`demo@example.com` / `password1234`) でログイン
2. 同意画面: CIMD から取得したクライアント名 `MCP Demo CLI Client` と要求スコープを確認して「許可」
3. ターミナルに `whoami` / `hello` ツールの実行結果が表示される

```
✔ アクセストークンを取得しました
✔ MCP サーバーに接続しました

ツール一覧: hello, whoami

whoami の結果:
{
  "userId": "VuKyK797Vv22cqRGIBM3LOnEZ3FZKRdZ",
  "clientId": "https://mcp-demo-client.example.com/oauth/client-metadata.json",
  "scopes": ["mcp:tools", "offline_access"],
  ...
}
```

トークンなしでアクセスすると 401 になることも確認できます。

```bash
curl -i -X POST http://localhost:3000/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `src/` を `build/` にコンパイル |
| `npm run dev` | MCP サーバーを tsx でウォッチ実行 |
| `npm run dev:auth` | 認証サーバーを tsx でウォッチ実行 |
| `npm start` | ビルド済み MCP サーバーを起動 |
| `npm run start:auth` | ビルド済み認証サーバーを起動 |
| `npm run demo:client` | デモクライアントを実行 (OAuth フロー → ツール呼び出し) |
| `npm run typecheck` | 型チェックのみ実行 |
| `npm run inspect` | MCP Inspector を起動 |

## 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `MCP_SERVER_URL` | `http://localhost:3000/mcp` | MCP サーバーの URL (トークンの `aud`) |
| `AUTH_SERVER_URL` | `http://localhost:4000` | 認証サーバーの URL (トークンの `iss`) |
| `HOST` / `PORT` | `127.0.0.1` / URL のポート | MCP サーバーの待ち受け |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / URL のポート | 認証サーバーの待ち受け |
| `BETTER_AUTH_SECRET` | 開発用の固定値 | better-auth の署名・暗号化用シークレット (本番では必須) |
| `AUTH_DB_FILE` | `:memory:` | 認証サーバーの SQLite ファイル |
| `CIMD_DEMO_CLIENT` | (有効) | `false` でデモクライアント用のローカル応答を無効化 |
| `DEMO_CLIENT_CALLBACK_PORT` | `8090` | デモクライアントのコールバックポート |
| `NO_BROWSER` | (なし) | 設定するとデモクライアントがブラウザを自動で開かない |

## 他の MCP クライアントから使う場合

認証サーバーは DCR を無効にしているため、**CIMD に対応したクライアント** である必要があります。
クライアントのメタデータ文書は公開 URL から取得されるので、認証サーバーからその URL にアクセスできる必要があります。

## ファイル構成

```
src/config.ts                 共有設定 (各サーバーの URL、スコープ)
src/index.ts                  MCP サーバー (Express, Protected Resource Metadata, トークン検証)
src/server.ts                 McpServer のファクトリ (hello / whoami ツール)
src/auth-server/index.ts      認証サーバー (Express, メタデータ配信, ログイン・同意画面)
src/auth-server/auth.ts       better-auth の設定 (jwt / mcp / cimd プラグイン)
src/auth-server/cimd-fetch.ts CIMD メタデータ文書の取得処理
src/auth-server/pages.ts      ログイン画面・同意画面の HTML
src/demo-client/index.ts      デモ用 MCP クライアント (CLI)
src/demo-client/metadata.ts   デモクライアントのメタデータ文書 (CIMD)
```

## 使用パッケージ

- `@modelcontextprotocol/server` — MCP サーバー本体 (v2)
- `@modelcontextprotocol/express` — Express アプリの生成 (JSON パース、Host/Origin 検証)
- `@modelcontextprotocol/node` — Node.js の req/res 向け Streamable HTTP アダプター
- `@modelcontextprotocol/client` — デモクライアント (OAuth / CIMD 対応)
- `better-auth` — 認証サーバー
- `@better-auth/mcp` — MCP 向け OAuth 2.1 認可サーバー / リソースサーバー用のトークン検証
- `@better-auth/cimd` — Client ID Metadata Document によるクライアント登録
- `@better-auth/oauth-provider` — 認可サーバーメタデータの配信
- `jose` — JWT クレームの型
- `express` — HTTP サーバー
- `zod` — ツール入力スキーマの定義
