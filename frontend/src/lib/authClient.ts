import { createAuthClient } from "better-auth/react";
import { ssoClient } from "@better-auth/sso/client";

// With the Vite dev proxy the same-origin default resolves to /api/auth on
// the backend. When VITE_API_URL points elsewhere, follow it.
const apiBase = import.meta.env.VITE_API_URL;

export const authClient = createAuthClient({
  ...(apiBase ? { baseURL: `${apiBase}/auth` } : {}),
  plugins: [ssoClient()],
});
