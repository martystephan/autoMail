import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { sso } from '@better-auth/sso';
import prisma from '../utils/prisma';

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:4000';

export const samlEnabled = process.env.SAML_ENABLED === 'true';
export const samlProviderId = process.env.SAML_PROVIDER_ID || 'default-saml';

function buildDefaultSSO() {
  const domain = process.env.SAML_DOMAIN;
  const entryPoint = process.env.SAML_ENTRY_POINT;
  const certB64 = process.env.SAML_CERT;
  const idpEntityId = process.env.SAML_IDP_ENTITY_ID;
  if (!domain || !entryPoint || !certB64 || !idpEntityId) {
    throw new Error(
      'SAML_ENABLED=true requires SAML_DOMAIN, SAML_ENTRY_POINT, SAML_CERT, and SAML_IDP_ENTITY_ID to be set.'
    );
  }
  return [
    {
      providerId: samlProviderId,
      domain,
      samlConfig: {
        issuer: process.env.SAML_ISSUER || `${BETTER_AUTH_URL}/api/auth/sso/saml2/sp/metadata`,
        entryPoint,
        cert: Buffer.from(certB64, 'base64').toString('utf-8'),
        callbackUrl: `${BETTER_AUTH_URL}/api/auth/sso/saml2/sp/acs/${samlProviderId}`,
        identifierFormat:
          process.env.SAML_IDENTIFIER_FORMAT ||
          'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        mapping: { id: 'nameID', email: 'email', name: 'displayName' },
        // Required by the plugin's type even though every field is optional —
        // we don't customize SP metadata beyond the auto-generated defaults.
        spMetadata: {},
        // Without an explicit entityID here, the plugin falls back to our
        // own SP issuer for the IdP's expected entityID too, which fails
        // signature/issuer validation (ERR_UNMATCH_ISSUER) against any real
        // IdP whose entityID differs from our SP's (i.e. always).
        idpMetadata: { entityID: idpEntityId },
      },
    },
  ];
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'sqlite' }),
  emailAndPassword: { enabled: true, minPasswordLength: 6 },
  trustedOrigins: [process.env.FRONTEND_URL ?? 'http://localhost:5173'],
  // Cache the session in a signed cookie so protected API calls don't hit the
  // session table on every request
  session: { cookieCache: { enabled: true, maxAge: 300 } },
  plugins: samlEnabled
    ? [
        sso({
          defaultSSO: buildDefaultSSO(),
          // @better-auth/sso's `requestSignUp` override (and therefore
          // disableImplicitSignUp) is only wired up for the OIDC flow — the
          // SAML callback never reads it (generateRelayState is called with
          // additionalData hardcoded to `false`). So implicit sign-up must
          // stay enabled here, and the single-admin invariant is enforced
          // below in provisionUser instead: any SSO signup beyond the very
          // first user is undone and rejected before a session is granted.
          disableImplicitSignUp: false,
          provisionUser: async ({ user }) => {
            if ((await prisma.user.count()) > 1) {
              await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
              throw new APIError('FORBIDDEN', {
                message: 'Registration is disabled. A user already exists.',
              });
            }
          },
          // Marks our defaultSSO provider as trusted (matched against
          // SAML_DOMAIN) without a real DNS TXT lookup — appropriate since
          // the admin who set SAML_DOMAIN controls both the SP and the IdP.
          // Needed so better-auth will link a SAML login to an existing
          // local-password user by email instead of rejecting with
          // "account not linked" (see account.accountLinking below).
          domainVerification: { enabled: true },
          // Reject IdP-initiated logins by default (protects against
          // unsolicited-response attacks). Real IdPs echo InResponseTo on
          // SP-initiated logins, so this doesn't affect the normal flow —
          // only mocksaml.com's simplified test IdP needed this relaxed
          // during manual verification.
          saml: { enableInResponseToValidation: true, allowIdpInitiated: false },
        }),
      ]
    : [],
  account: {
    accountLinking: {
      // This app never implements a local email-verification flow, so
      // dbUser.emailVerified is always false for the admin created via
      // /sign-up/email — without this, better-auth refuses to link any
      // SSO login to that account at all, regardless of provider trust.
      requireLocalEmailVerified: false,
    },
  },
  hooks: {
    // Single-admin setup: registration is only open while no user exists.
    // Unaffected by SSO — the plugin's routes never match '/sign-up/email'.
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
