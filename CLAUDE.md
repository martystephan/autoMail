# autoMail

Email automation tool for moving emails between accounts automatically.

## Project Overview

This project enables automated email movement between different mail accounts (IMAP and Microsoft OAuth). Users configure mail accounts and create automation flows that move emails from one mailbox to another based on triggers (e.g., intervals).

## Architecture

- **Backend** (`/backend`): Express.js server (TypeScript) - handles all automation logic, account management, and email operations. Data stored in SQLite via Prisma (`backend/prisma/schema.prisma`; schema changes go through `npx prisma migrate dev`).
- **Frontend** (`/frontend`): React + Vite + Tailwind - configuration UI only, no business logic.

## Authentication

better-auth (email + password, cookie sessions) with the Prisma adapter. Server instance in `backend/src/lib/auth.ts`, mounted in `index.ts` at `/api/auth/*` BEFORE `express.json()` (it needs the raw body); `requireAuth` middleware validates the session cookie. Registration is only open while no user exists (first-run setup). Frontend uses `better-auth/react` (`frontend/src/lib/authClient.ts`) wrapped by `AuthContext`. Note: `JWT_SECRET`/`jsonwebtoken` are NOT part of user auth — they sign OAuth CSRF state tokens (`routes/oauth/stateToken.ts`).

**SAML SSO**: optional, via the `@better-auth/sso` plugin, gated by `SAML_ENABLED` in `backend/.env` (see `.env.example` for the full var list — `SAML_DOMAIN`, `SAML_ENTRY_POINT`, `SAML_IDP_ENTITY_ID`, `SAML_CERT` base64-encoded, etc.). Configured as a single static `defaultSSO` provider — no dynamic provider-registration UI. Verified end-to-end against a real IdP (mocksaml.com) during development; several plugin behaviors weren't obvious from its docs and are load-bearing here:
  - `idpMetadata: { entityID: SAML_IDP_ENTITY_ID }` is required — without it the plugin defaults the *expected IdP entityID* to our own SP issuer, which fails signature validation (`ERR_UNMATCH_ISSUER`) against any real IdP.
  - The plugin's `requestSignUp`/`disableImplicitSignUp` gate is **only wired up for OIDC** — the SAML callback path never reads `requestSignUp` at all. The single-admin invariant (SSO may create the first user, never a second) is instead enforced in `provisionUser`: `disableImplicitSignUp: false` lets SSO create a user when none matches by email, and `provisionUser` deletes-and-rejects if that push the user count above 1.
  - better-auth's core account-linking gate independently blocks linking a new SAML identity to an existing local-password account unless the provider is "trusted" or the local user's `emailVerified` is true. This app has no email-verification flow, so both `domainVerification: { enabled: true }` (marks the static provider trusted, matched against `SAML_DOMAIN`) and `account.accountLinking.requireLocalEmailVerified: false` are set — otherwise every SSO re-login gets rejected with `account_not_linked`.
  - The frontend's `signIn.sso({ callbackURL })` must be an **absolute** URL (`${window.location.origin}/`) — a relative `"/"` resolves against the backend's own origin, not the frontend's.

  Adding/changing plugin config requires re-running `npx --yes @better-auth/cli@latest generate --yes` (regenerates `ssoProvider` in `schema.prisma` — pass real or dummy `SAML_*` env vars inline so the CLI's config load doesn't throw) followed by `npx prisma migrate dev`.

## Core Concepts

- **Mail Accounts**: IMAP (password-based) or Microsoft (OAuth2)
- **Automation Flows**: Source account/mailbox -> Target account/mailbox
- **Triggers**: Interval-based execution of flows

## Tech Stack

- Backend: Express 5, TypeScript, Prisma 6 + SQLite, better-auth, ts-node (tsconfig uses `module: nodenext` so the ESM-only better-auth package resolves; Prisma is pinned to v6 — v7 is ESM-first and doesn't fit this CommonJS setup)
- Frontend: React 19, Vite 7, Tailwind CSS 4, TypeScript

## Commands

```bash
# Backend
cd backend && npm run dev

# Frontend
cd frontend && npm run dev
```
