/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document) の取得と検証。
 *
 * CIMD では client_id そのものが「クライアントのメタデータ JSON を置いた HTTPS URL」になる。
 * 認可サーバーは事前登録なしにその URL を取得し、文書の内容 (redirect_uris など) でクライアントを検証する。
 */
import { z } from "zod";

/** デモ用: http://localhost などの loopback URL を client_id として許可する */
const ALLOW_INSECURE_CLIENT_ID_URLS = (process.env.ALLOW_INSECURE_CLIENT_ID_URLS ?? "true") !== "false";

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const DEFAULT_CACHE_SEC = 5 * 60;
const MAX_CACHE_SEC = 24 * 60 * 60;

export class ClientMetadataError extends Error {}

const absoluteUrl = z.string().refine((value) => {
  try {
    return !new URL(value).hash;
  } catch {
    return false;
  }
}, "must be an absolute URL without fragment");

const ClientMetadataSchema = z
  .object({
    client_id: z.string(),
    client_name: z.string().max(200).optional(),
    client_uri: absoluteUrl.optional(),
    logo_uri: absoluteUrl.optional(),
    redirect_uris: z.array(absoluteUrl).min(1),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().optional(),
    client_secret: z.unknown().optional(),
    client_secret_expires_at: z.unknown().optional(),
  })
  .loose();

export type ClientMetadata = z.infer<typeof ClientMetadataSchema>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** client_id が CIMD の URL として妥当かを確認する */
function validateClientIdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError("client_id must be a URL (Client ID Metadata Document)");
  }
  const insecureLoopback = ALLOW_INSECURE_CLIENT_ID_URLS && url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !insecureLoopback) {
    throw new ClientMetadataError("client_id URL must use https");
  }
  if (url.pathname === "/" || url.pathname === "") {
    throw new ClientMetadataError("client_id URL must contain a path component");
  }
  if (url.hash || clientId.includes("#")) throw new ClientMetadataError("client_id URL must not contain a fragment");
  if (url.username || url.password) throw new ClientMetadataError("client_id URL must not contain credentials");
  // URL パーサーは . / .. を正規化してしまうので元の文字列で確認する
  if (/\/\.\.?(\/|$|\?)/.test(clientId)) {
    throw new ClientMetadataError("client_id URL must not contain dot path segments");
  }
  return url;
}

interface CacheEntry {
  metadata: ClientMetadata;
  expiresAt: number; // epoch ms
}
const cache = new Map<string, CacheEntry>();

function cacheSeconds(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_CACHE_SEC;
  if (/\b(no-store|no-cache)\b/i.test(cacheControl)) return 0;
  const maxAge = /max-age=(\d+)/i.exec(cacheControl);
  return maxAge ? Math.min(Number(maxAge[1]), MAX_CACHE_SEC) : DEFAULT_CACHE_SEC;
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new ClientMetadataError("client metadata document is too large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new ClientMetadataError("client metadata document is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * client_id (URL) からクライアントのメタデータを取得・検証して返す。
 * 失敗時は理由付きの ClientMetadataError を投げる。
 */
export async function resolveClient(clientId: string): Promise<ClientMetadata> {
  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;

  const url = validateClientIdUrl(clientId);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error", // リダイレクト先の文書は受け付けない
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ClientMetadataError(`failed to fetch client metadata document: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new ClientMetadataError(`failed to fetch client metadata document: HTTP ${response.status}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readLimited(response));
  } catch (error) {
    if (error instanceof ClientMetadataError) throw error;
    throw new ClientMetadataError("client metadata document is not valid JSON");
  }

  const parsed = ClientMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ClientMetadataError(`invalid client metadata: ${issue?.path.join(".")} ${issue?.message}`);
  }
  const metadata = parsed.data;

  if (metadata.client_id !== clientId) {
    throw new ClientMetadataError("client_id in the document does not match the document URL");
  }
  if (metadata.client_secret !== undefined || metadata.client_secret_expires_at !== undefined) {
    throw new ClientMetadataError("client metadata document must not contain client_secret");
  }
  const authMethod = metadata.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    throw new ClientMetadataError(`unsupported token_endpoint_auth_method: ${authMethod} (public clients only)`);
  }
  if (metadata.grant_types && !metadata.grant_types.includes("authorization_code")) {
    throw new ClientMetadataError("grant_types must include authorization_code");
  }

  const ttl = cacheSeconds(response.headers.get("cache-control"));
  if (ttl > 0) cache.set(clientId, { metadata, expiresAt: Date.now() + ttl * 1000 });
  console.log(`[auth] fetched client metadata document: ${clientId}`);
  return metadata;
}

/**
 * redirect_uri が文書の redirect_uris に含まれるか。
 * loopback の http URI は RFC 8252 §7.3 に従いポート番号を無視して比較する
 * (ネイティブアプリはランダムなポートでコールバックを待ち受けるため)。
 */
export function isRedirectUriAllowed(metadata: ClientMetadata, redirectUri: string): boolean {
  if (metadata.redirect_uris.includes(redirectUri)) return true;

  let requested: URL;
  try {
    requested = new URL(redirectUri);
  } catch {
    return false;
  }
  if (requested.protocol !== "http:" || !isLoopbackHost(requested.hostname)) return false;

  return metadata.redirect_uris.some((registered) => {
    const r = new URL(registered);
    return (
      r.protocol === "http:" &&
      r.hostname === requested.hostname &&
      r.pathname === requested.pathname &&
      r.search === requested.search
    );
  });
}
