# autoMail

Email automation tool for moving emails between accounts automatically.

## Project Overview

This project enables automated email movement between different mail accounts (IMAP and Microsoft OAuth). Users configure mail accounts and create automation flows that move emails from one mailbox to another based on triggers (e.g., intervals).

## Architecture

- **Backend** (`/backend`): Express.js server (TypeScript) - handles all automation logic, account management, and email operations. Data stored in SQLite via Prisma (`backend/prisma/schema.prisma`; schema changes go through `npx prisma migrate dev`).
- **Frontend** (`/frontend`): React + Vite + Tailwind - configuration UI only, no business logic.

## Authentication

better-auth (email + password, cookie sessions) with the Prisma adapter. Server instance in `backend/src/lib/auth.ts`, mounted in `index.ts` at `/api/auth/*` BEFORE `express.json()` (it needs the raw body); `requireAuth` middleware validates the session cookie. Registration is only open while no user exists (first-run setup). Frontend uses `better-auth/react` (`frontend/src/lib/authClient.ts`) wrapped by `AuthContext`. Future SSO/SAML goes into `plugins: []` in `lib/auth.ts` + `npx @better-auth/cli generate` + a Prisma migration. Note: `JWT_SECRET`/`jsonwebtoken` are NOT part of user auth — they sign OAuth CSRF state tokens (`routes/oauth/stateToken.ts`).

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
