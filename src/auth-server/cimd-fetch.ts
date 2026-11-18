import { fetchClientMetadataResource as nodeFetchClientMetadataResource } from "@better-auth/cimd/node";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { DEMO_CLIENT_ID, demoClientMetadata } from "../demo-client/metadata.js";

/**
 * CIMD のメタデータ文書を取得するトランスポート。
 *
 * 通常は `@better-auth/cimd/node` の実装 (DNS を一度だけ解決し、公開アドレスに
 * 接続を固定、リダイレクトを拒否する SSRF 対策済みの取得処理) をそのまま使う。
 * これにより VS Code など、メタデータ文書を公開している実クライアントも利用できる。
 *
 * ローカルデモ用に、デモクライアントの client_id URL だけは
 * ネットワークに出ずに手元の文書を返す。本番では `CIMD_DEMO_CLIENT=false`
 * にするか、この分岐自体を削除すること。
 */
const serveDemoClientLocally = process.env.CIMD_DEMO_CLIENT !== "false";

export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (
  input,
  init,
) => {
  const url = new Request(input, init).url;
  if (serveDemoClientLocally && url === DEMO_CLIENT_ID) {
    console.log(`[cimd] デモクライアントのメタデータ文書を返します: ${url}`);
    return Response.json(demoClientMetadata, {
      headers: { "Cache-Control": "max-age=300" },
    });
  }
  console.log(`[cimd] メタデータ文書を取得します: ${url}`);
  return nodeFetchClientMetadataResource(input, init);
};
