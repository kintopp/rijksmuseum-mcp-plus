/**
 * Stub OAuth provider for Claude mobile/desktop compatibility.
 *
 * Claude clients perform OAuth discovery (RFC 8414 / RFC 9728) before
 * connecting to an MCP server. Without valid endpoints they fail with
 * confusing auth errors even though the server is fully public.
 *
 * This provider issues real-looking tokens but the /mcp endpoint never
 * checks them — keeping the server fully open.
 */
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// ─── In-memory client store (DCR) ────────────────────────────────────

class StubClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    this.clients.set(full.client_id, full);
    return full;
  }
}

// ─── Stub provider ───────────────────────────────────────────────────

/** Map auth-code → PKCE code_challenge (needed by the SDK's PKCE check). */
const pendingCodes = new Map<string, string>();

export class StubOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new StubClientsStore();

  async authorize(
    _client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Issue a code immediately — no login page needed.
    const code = randomUUID();
    pendingCodes.set(code, params.codeChallenge);

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const challenge = pendingCodes.get(authorizationCode);
    if (!challenge) throw new Error("Unknown authorization code");
    return challenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    pendingCodes.delete(authorizationCode);
    return {
      access_token: randomUUID(),
      token_type: "bearer",
      expires_in: 86400,
      refresh_token: randomUUID(),
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    return {
      access_token: randomUUID(),
      token_type: "bearer",
      expires_in: 86400,
      refresh_token: randomUUID(),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Accept any non-empty token — stub server, no enforcement.
    return { token, clientId: "stub", scopes: [] };
  }
}
