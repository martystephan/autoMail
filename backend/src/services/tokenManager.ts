import { getProvider } from "../config/oauthProviders";
import prisma from "../utils/prisma";
import { encryptPassword, decryptPassword } from "../utils/crypto";

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  idTokenClaims?: {
    email?: string;
    preferred_username?: string;
    upn?: string;
    name?: string;
  };
}

interface UserInfo {
  email: string;
  name?: string;
}

/**
 * Generate OAuth authorization URL for a provider
 */
export function getAuthorizationUrl(
  provider: string,
  redirectUri: string,
  state: string
): string {
  const config = getProvider(provider);
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state: state,
    response_mode: "query",
  });

  // Microsoft-specific: request offline access for refresh token
  if (provider === "microsoft") {
    params.append("prompt", "consent");
  }

  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  provider: string,
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const config = getProvider(provider);
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Token exchange error:", errorData);
    throw new Error(`Failed to exchange code for tokens: ${response.status}`);
  }

  const data = await response.json();

  // Calculate token expiration
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Parse ID token for Microsoft to get user info
  let idTokenClaims: TokenResponse["idTokenClaims"];
  if (provider === "microsoft" && data.id_token) {
    try {
      const payload = data.id_token.split(".")[1];
      idTokenClaims = JSON.parse(Buffer.from(payload, "base64").toString());
    } catch (e) {
      console.error("Failed to parse ID token:", e);
    }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope,
    idTokenClaims,
  };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  provider: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const config = getProvider(provider);
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Token refresh error:", errorData);
    throw new Error(`Failed to refresh token: ${response.status}`);
  }

  const data = await response.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  return {
    accessToken: data.access_token,
    // Microsoft may or may not return a new refresh token
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
  };
}

/**
 * Check if token is expired (with 5-minute buffer)
 */
export function isTokenExpired(tokenExpiresAt: Date | string | null): boolean {
  if (!tokenExpiresAt) return true;
  const bufferMs = 5 * 60 * 1000; // 5 minutes
  return new Date(tokenExpiresAt).getTime() - bufferMs < Date.now();
}

/**
 * Get a valid access token for a mail account, refreshing if necessary
 */
export async function getValidAccessToken(mailAccountId: number): Promise<string> {
  const account = await prisma.mailAccount.findUnique({ where: { id: mailAccountId } });

  if (!account) {
    throw new Error("Mail account not found");
  }

  if (account.type !== "microsoft") {
    throw new Error("Not an OAuth account");
  }

  if (!account.accessToken || !account.refreshToken) {
    throw new Error("Missing OAuth tokens");
  }

  // Check if token needs refresh
  if (!isTokenExpired(account.tokenExpiry)) {
    return decryptPassword(account.accessToken);
  }

  // Refresh the token
  const decryptedRefreshToken = decryptPassword(account.refreshToken);
  const newTokens = await refreshAccessToken("microsoft", decryptedRefreshToken);

  // Update the account with new tokens
  await prisma.mailAccount.update({
    where: { id: mailAccountId },
    data: {
      accessToken: encryptPassword(newTokens.accessToken),
      refreshToken: encryptPassword(newTokens.refreshToken),
      tokenExpiry: newTokens.expiresAt,
    },
  });

  return newTokens.accessToken;
}

/**
 * Get user info from OAuth provider API
 */
export async function getUserInfo(
  provider: string,
  accessToken: string
): Promise<UserInfo> {
  if (provider === "microsoft") {
    const response = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to get user info from Microsoft");
    }

    const data = await response.json();
    return {
      email: data.mail || data.userPrincipalName,
      name: data.displayName,
    };
  }

  throw new Error(`User info not supported for provider: ${provider}`);
}
