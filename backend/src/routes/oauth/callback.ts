import { Request, Response, RequestHandler } from "express";
import prisma from "../../utils/prisma";
import { HTTP_STATUS } from "../../constants";
import { encryptPassword } from "../../utils/crypto";
import { exchangeCodeForTokens, getUserInfo } from "../../services/tokenManager";
import { isValidProvider, getProvider } from "../../config/oauthProviders";
import { verifyStateToken } from "./stateToken";

/**
 * GET /api/oauth/:provider/callback
 * Handle OAuth callback and exchange code for tokens
 */
export const callbackHandler = (async (req: Request, res: Response) => {
  const provider = req.params.provider as string;
  const { code, state, error, error_description } = req.query;

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  // Handle OAuth errors
  if (error) {
    return res.redirect(
      `${frontendUrl}/oauth/callback?error=${error}&description=${
        error_description || ""
      }`
    );
  }

  if (!isValidProvider(provider)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: "Invalid OAuth provider" });
  }

  if (
    !code ||
    !state ||
    typeof code !== "string" ||
    typeof state !== "string"
  ) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: "Missing authorization code or state" });
  }

  // Verify JWT state token for CSRF protection
  const stateData = verifyStateToken(state);
  if (!stateData) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: "Invalid or expired state token" });
  }

  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
  const redirectUri = `${backendUrl}/api/oauth/${provider}/callback`;

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(provider, code, redirectUri);

    // Validate that required scopes were granted
    const grantedScopes = tokens.scope?.split(" ") || [];
    const requiredMailScope = "https://outlook.office.com/IMAP.AccessAsUser.All";

    if (!grantedScopes.includes(requiredMailScope)) {
      return res.redirect(
        `${frontendUrl}/oauth/callback?error=missing_scope&description=Mail access permission was not granted. Please try again and allow mail access.`
      );
    }

    // Get provider config for IMAP settings
    const providerConfig = getProvider(provider)!;

    // Get user info - try ID token first (for Microsoft), then fallback to API
    let userEmail: string;
    let userName: string | undefined;

    if (provider === "microsoft" && tokens.idTokenClaims) {
      // Extract email from ID token claims for Microsoft
      userEmail =
        tokens.idTokenClaims.email ||
        tokens.idTokenClaims.preferred_username ||
        tokens.idTokenClaims.upn ||
        "";
      userName = tokens.idTokenClaims.name;

      if (!userEmail) {
        // Fallback to API if no email in token
        const userInfo = await getUserInfo(provider, tokens.accessToken);
        userEmail = userInfo.email;
        userName = userInfo.name;
      }
    } else {
      // Fetch from API
      const userInfo = await getUserInfo(provider, tokens.accessToken);
      userEmail = userInfo.email;
      userName = userInfo.name;
    }

    // Create mail account
    const account = await prisma.mailAccount.create({
      data: {
        name: userName || userEmail,
        type: "microsoft",
        email: userEmail,
        imapHost: providerConfig.imap.host,
        imapPort: providerConfig.imap.port,
        accessToken: encryptPassword(tokens.accessToken),
        refreshToken: encryptPassword(tokens.refreshToken),
        tokenExpiry: tokens.expiresAt,
      },
    });

    // Redirect to frontend with success
    res.redirect(
      `${frontendUrl}/oauth/callback?success=true&provider=${provider}&accountId=${account.id}`
    );
  } catch (error) {
    console.error("Error in OAuth callback:", error);
    res.redirect(
      `${frontendUrl}/oauth/callback?error=exchange_failed&description=Failed to exchange authorization code`
    );
  }
}) as RequestHandler;
