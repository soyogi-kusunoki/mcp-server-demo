/**
 * OAuth (CIMD) 対応のデモ MCP クライアント (CLI)。
 *
 * 1. MCP サーバーに接続 → 401 を受け取り、Protected Resource Metadata から認証サーバーを発見
 * 2. 認証サーバーのメタデータで `client_id_metadata_document_supported` を確認し、
 *    client_id にメタデータ文書の URL を使って認可リクエストを組み立てる (事前登録なし)
 * 3. ブラウザでログイン・同意 → http://127.0.0.1:8090/callback で認可コードを受け取る
 * 4. 認可コード + PKCE でトークンを取得し、MCP サーバーのツールを呼び出す
 */
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  OAuthClientMetadata,
  OAuthDiscoveryState,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { MCP_SERVER_URL } from "../config.js";
import {
  DEMO_CLIENT_CALLBACK_PORT,
  DEMO_CLIENT_ID,
  DEMO_CLIENT_REDIRECT_URI,
  demoClientMetadata,
} from "./metadata.js";

/** トークン等をメモリに保持するだけの最小限の OAuthClientProvider */
class DemoOAuthProvider implements OAuthClientProvider {
  private _tokens?: StoredOAuthTokens;
  private _clientInfo?: StoredOAuthClientInformation;
  private _codeVerifier?: string;
  private _discoveryState?: OAuthDiscoveryState;
  private _state = crypto.randomUUID();

  /** CIMD: この URL が client_id として使われる */
  readonly clientMetadataUrl = DEMO_CLIENT_ID;

  get redirectUrl() {
    return DEMO_CLIENT_REDIRECT_URI;
  }
  get clientMetadata(): OAuthClientMetadata {
    const { client_id: _, ...metadata } = demoClientMetadata;
    return {
      ...metadata,
      redirect_uris: [...metadata.redirect_uris],
      grant_types: [...metadata.grant_types],
      response_types: [...metadata.response_types],
    };
  }
  state() {
    return this._state;
  }
  clientInformation() {
    return this._clientInfo;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this._clientInfo = info;
  }
  tokens() {
    return this._tokens;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this._tokens = tokens;
  }
  saveCodeVerifier(codeVerifier: string) {
    this._codeVerifier = codeVerifier;
  }
  codeVerifier() {
    if (!this._codeVerifier) throw new Error("code verifier がありません");
    return this._codeVerifier;
  }
  // 認可リクエスト時に発見した認証サーバーを記録し、コールバック時に同じサーバーか検証させる
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this._discoveryState = state;
  }
  discoveryState() {
    return this._discoveryState;
  }
  redirectToAuthorization(url: URL) {
    console.log("\n▶ ブラウザで次の URL を開いてログイン・許可してください:\n");
    console.log(`  ${url.toString()}\n`);
    console.log(`  (client_id = ${url.searchParams.get("client_id")})\n`);
    openBrowser(url.toString());
  }
}

/** 可能ならブラウザを自動で開く (失敗しても無視) */
function openBrowser(url: string) {
  if (process.env.NO_BROWSER) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // ignore
  }
}

/** ループバックでリダイレクトを待ち受け、コールバックのクエリを返す */
function waitForCallback(expectedState: string): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", DEMO_CLIENT_REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      const ok = params.has("code") && params.get("state") === expectedState;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<h1>認可が完了しました</h1><p>このタブを閉じてターミナルに戻ってください。</p>"
          : "<h1>認可に失敗しました</h1><p>ターミナルを確認してください。</p>",
      );
      server.close();
      if (ok) resolve(params);
      else reject(new Error(`認可エラー: ${params.get("error") ?? "state が一致しません"}`));
    });
    server.listen(DEMO_CLIENT_CALLBACK_PORT, "127.0.0.1");
  });
}

async function connect(provider: DemoOAuthProvider) {
  const client = new Client({ name: "mcp-demo-cli-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    authProvider: provider,
  });
  await client.connect(transport);
  return client;
}

async function main() {
  const provider = new DemoOAuthProvider();
  console.log(`MCP サーバー ${MCP_SERVER_URL} に接続します…`);

  let client: Client;
  try {
    client = await connect(provider);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    // 認可が必要: コールバックを待ち、認可コードをトークンに交換する
    const params = await waitForCallback(provider.state());
    const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
      authProvider: provider,
    });
    await transport.finishAuth(params);
    console.log("✔ アクセストークンを取得しました");
    client = await connect(provider);
  }

  console.log("✔ MCP サーバーに接続しました\n");

  const { tools } = await client.listTools();
  console.log("ツール一覧:", tools.map((t) => t.name).join(", "));

  const whoami = await client.callTool({ name: "whoami", arguments: {} });
  console.log("\nwhoami の結果:");
  for (const c of whoami.content as { type: string; text?: string }[]) {
    if (c.type === "text") console.log(c.text);
  }

  const hello = await client.callTool({ name: "hello", arguments: { name: "OAuth" } });
  console.log("\nhello の結果:");
  for (const c of hello.content as { type: string; text?: string }[]) {
    if (c.type === "text") console.log(c.text);
  }

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
