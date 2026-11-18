import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * デモ用のインメモリストア。プロセスを再起動するとすべて消える。
 * 本番環境では永続化ストアやトークンのハッシュ保存などを検討すること。
 */

export interface AuthorizationCode {
  code: string;
  clientId: string; // Client ID Metadata Document の URL
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  sub: string;
  expiresAt: number; // epoch ms
}

export interface AccessToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  sub: string;
  expiresAt: number; // epoch seconds
}

export interface RefreshToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  sub: string;
}

export const authorizationCodes = new Map<string, AuthorizationCode>();
export const accessTokens = new Map<string, AccessToken>();
export const refreshTokens = new Map<string, RefreshToken>();

/** URL-safe なランダム文字列を生成する */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE (S256): BASE64URL(SHA256(code_verifier)) */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** タイミング攻撃を避けた文字列比較 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
