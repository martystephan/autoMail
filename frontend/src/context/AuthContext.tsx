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
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);

  useEffect(() => {
    getSetupStatus()
      .then((status) => setNeedsSetup(status.needsSetup))
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

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        isLoading: isPending || setupLoading,
        needsSetup,
        login,
        register,
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
