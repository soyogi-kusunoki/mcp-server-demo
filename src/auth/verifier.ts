import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

interface IntrospectionResponse {
  active: boolean;
  client_id?: string;
  scope?: string;
  exp?: number;
  sub?: string;
  aud?: string | string[];
}

/**
 * Authorization Server の Token Introspection (RFC 7662) でアクセストークンを検証する。
 * 検証結果の AuthInfo は requireBearerAuth がスコープ・有効期限・resource (audience) を確認したうえで
 * MCP のリクエストハンドラへ ctx.http.authInfo として渡される。
 */
export function createIntrospectionVerifier(options: {
  introspectionEndpoint: string;
  clientSecret: string;
}): OAuthTokenVerifier {
  const authorization = `Basic ${Buffer.from(`mcp-server:${options.clientSecret}`).toString("base64")}`;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let data: IntrospectionResponse;
      try {
        const response = await fetch(options.introspectionEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: authorization,
          },
          body: new URLSearchParams({ token, token_type_hint: "access_token" }),
        });
        if (!response.ok) throw new Error(`introspection failed: HTTP ${response.status}`);
        data = (await response.json()) as IntrospectionResponse;
      } catch (error) {
        // 認可サーバーに到達できない等はサーバー側の障害として扱う (500)
        throw new Error(`token introspection error: ${(error as Error).message}`);
      }

      if (!data.active) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "token is inactive, expired or unknown");
      }

      const aud = Array.isArray(data.aud) ? data.aud[0] : data.aud;
      return {
        token,
        clientId: data.client_id ?? "unknown",
        scopes: data.scope?.split(" ").filter(Boolean) ?? [],
        expiresAt: data.exp,
        resource: aud ? new URL(aud) : undefined,
        extra: { sub: data.sub },
      };
    },
  };
}
