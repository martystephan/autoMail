import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { authClient } from "../lib/authClient";
import { getSetupStatus } from "../api/auth";

export interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  needsSetup: boolean;
  ssoEnabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithSso: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoProviderId, setSsoProviderId] = useState<string | undefined>();

  useEffect(() => {
    getSetupStatus()
      .then((status) => {
        setNeedsSetup(status.needsSetup);
        setSsoEnabled(status.ssoEnabled);
        setSsoProviderId(status.ssoProviderId);
      })
      .catch(() => setNeedsSetup(false))
      .finally(() => setSetupLoading(false));
  }, []);

  // The better-auth client returns { data, error } instead of throwing —
  // convert errors so the pages' catch blocks keep working.
  async function login(email: string, password: string) {
    const { error } = await authClient.signIn.email({ email, password });
    if (error) throw new Error(error.message || "Login failed");
  }

  async function register(email: string, password: string) {
    const { error } = await authClient.signUp.email({
      email,
      password,
      name: email.split("@")[0],
    });
    if (error) throw new Error(error.message || "Registration failed");
    setNeedsSetup(false);
  }

  async function logout() {
    await authClient.signOut();
  }

  // The provider ID only becomes known once /auth/setup-status resolves.
  // The single-admin invariant (SSO may create the first user, never a
  // second) is enforced server-side in auth.ts's provisionUser hook, not
  // here — the plugin's requestSignUp override isn't wired up for SAML.
  async function loginWithSso() {
    if (!ssoProviderId) throw new Error("SSO is not configured");
    const { error } = await authClient.signIn.sso({
      providerId: ssoProviderId,
      // Must be absolute: the SAML callback is handled on the backend
      // origin, and a relative "/" would resolve against that origin
      // instead of the frontend's.
      callbackURL: `${window.location.origin}/`,
    });
    if (error) throw new Error(error.message || "SSO sign-in failed");
    // On success the browser navigates away to the IdP; this line is only
    // reached on failure.
  }

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        isLoading: isPending || setupLoading,
        needsSetup,
        ssoEnabled,
        login,
        register,
        loginWithSso,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
