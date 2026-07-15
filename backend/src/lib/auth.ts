import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import prisma from '../utils/prisma';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'sqlite' }),
  emailAndPassword: { enabled: true, minPasswordLength: 6 },
  trustedOrigins: [process.env.FRONTEND_URL ?? 'http://localhost:5173'],
  // Cache the session in a signed cookie so protected API calls don't hit the
  // session table on every request
  session: { cookieCache: { enabled: true, maxAge: 300 } },
  hooks: {
    // Single-admin setup: registration is only open while no user exists
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-up/email') return;
      if ((await prisma.user.count()) > 0) {
        throw new APIError('FORBIDDEN', {
          message: 'Registration is disabled. A user already exists.',
        });
      }
    }),
  },
});
