# mcp-server-demo

TypeScript で作成する MCP (Model Context Protocol) サーバーのデモです。

## 必要環境

- Node.js 18 以上

## セットアップ

```bash
npm install
npm run build
```

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `src/` を `build/` にコンパイル |
| `npm run dev` | tsx で `src/index.ts` をウォッチ実行 |
| `npm start` | ビルド済みサーバーを起動 (stdio) |
| `npm run typecheck` | 型チェックのみ実行 |
| `npm run inspect` | MCP Inspector でサーバーを確認 |

## Claude Code / Claude Desktop への登録例

```json
{
  "mcpServers": {
    "mcp-server-demo": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-demo/build/index.js"]
    }
  }
}
```

## 構成

```
src/index.ts   サーバー本体 (サンプルツール `hello` を登録)
```
