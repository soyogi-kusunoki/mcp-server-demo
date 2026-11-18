# mcp-server-demo

TypeScript で作成する MCP (Model Context Protocol) サーバーのデモです。
[MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) を使い、Streamable HTTP で提供します。

## 必要環境

- Node.js 20 以上

## セットアップ

```bash
npm install
npm run build
npm start
```

起動すると `http://127.0.0.1:3000/mcp` で待ち受けます。`HOST` / `PORT` 環境変数で変更できます。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `src/` を `build/` にコンパイル |
| `npm run dev` | tsx で `src/index.ts` をウォッチ実行 |
| `npm start` | ビルド済みサーバーを起動 |
| `npm run typecheck` | 型チェックのみ実行 |
| `npm run inspect` | MCP Inspector を起動 (Transport に Streamable HTTP、URL に `http://127.0.0.1:3000/mcp` を指定) |

## Claude Code への登録例

```bash
claude mcp add --transport http mcp-server-demo http://127.0.0.1:3000/mcp
```

## 構成

```
src/index.ts    Express サーバー (Streamable HTTP の /mcp エンドポイント、Host/Origin 検証)
src/server.ts   McpServer のファクトリ (ツール・リソース・プロンプトはここに登録)
```

## 使用パッケージ

- `@modelcontextprotocol/server` — MCP サーバー本体 (v2)
- `@modelcontextprotocol/express` — Express アプリの生成 (JSON パース、Host/Origin 検証)
- `@modelcontextprotocol/node` — Node.js の req/res 向け Streamable HTTP アダプター
- `express` — HTTP サーバー
- `zod` — ツール入力スキーマの定義
