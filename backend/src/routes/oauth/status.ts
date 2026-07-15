import { Request, Response, RequestHandler } from "express";
import prisma from "../../utils/prisma";
import { HTTP_STATUS } from "../../constants";
import { isTokenExpired } from "../../services/tokenManager";

/**
 * GET /api/oauth/status/:mailAccountId
 * Check OAuth token status for a mail account
 */
export const statusHandler = (async (req: Request, res: Response) => {
  const { mailAccountId } = req.params;

  const id = Number(mailAccountId);
  if (isNaN(id)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: "Invalid mail account ID" });
  }

  try {
    const mailAccount = await prisma.mailAccount.findUnique({
      where: { id },
      select: { id: true, type: true, email: true, tokenExpiry: true },
    });

    if (!mailAccount) {
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ error: "Mail account not found" });
    }

    if (mailAccount.type !== "microsoft") {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ error: "Not an OAuth mail account" });
    }

    const expired = isTokenExpired(mailAccount.tokenExpiry);

    res.json({
      id: mailAccount.id,
      email: mailAccount.email,
      tokenExpiresAt: mailAccount.tokenExpiry,
      isExpired: expired,
      isValid: !expired,
    });
  } catch (error) {
    console.error("Error checking token status:", error);
    res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to check token status" });
  }
}) as RequestHandler;
