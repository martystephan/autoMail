import { Request, Response, RequestHandler } from "express";
import prisma from "../../utils/prisma";
import { HTTP_STATUS } from "../../constants";
import { getValidAccessToken } from "../../services/tokenManager";
import { isValidProvider } from "../../config/oauthProviders";

/**
 * POST /api/oauth/:provider/refresh/:mailAccountId
 * Manually refresh access token for a mail account
 */
export const refreshHandler = (async (req: Request, res: Response) => {
  const provider = req.params.provider as string;
  const mailAccountId = req.params.mailAccountId as string;

  if (!isValidProvider(provider)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: "Invalid OAuth provider" });
  }

  const id = Number(mailAccountId);
  if (isNaN(id)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: "Invalid mail account ID" });
  }

  try {
    // Refresh token if needed
    await getValidAccessToken(id);

    // Get updated account info
    const mailAccount = await prisma.mailAccount.findUnique({
      where: { id },
      select: { id: true, tokenExpiry: true },
    });

    res.json({
      success: true,
      expiresAt: mailAccount?.tokenExpiry,
    });
  } catch (error) {
    console.error("Error refreshing token:", error);
    res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to refresh access token" });
  }
}) as RequestHandler;
