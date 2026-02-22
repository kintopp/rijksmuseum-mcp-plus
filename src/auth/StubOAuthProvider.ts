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

/** Auth-code → PKCE code_challenge with TTL (needed by the SDK's PKCE check). */
const CODE_TTL_MS = 600_000; // 10 minutes (RFC 6749 recommends short-lived codes)
const pendingCodes = new Map<string, { challenge: string; expiresAt: number }>();

export class StubOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new StubClientsStore();

  async authorize(
    _client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Prune expired codes
    const now = Date.now();
    for (const [k, v] of pendingCodes) {
      if (v.expiresAt < now) pendingCodes.delete(k);
    }

    // Issue a code immediately — no login page needed.
    const code = randomUUID();
    pendingCodes.set(code, { challenge: params.codeChallenge, expiresAt: now + CODE_TTL_MS });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = pendingCodes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now()) {
      pendingCodes.delete(authorizationCode);
      throw new Error("Unknown or expired authorization code");
    }
    return entry.challenge;
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
