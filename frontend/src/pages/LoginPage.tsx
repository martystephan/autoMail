import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { Button, Input, Label } from "../components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const { login, ssoEnabled, loginWithSso } = useAuth();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      // On success the session updates and the AuthGate swaps to the app,
      // keeping the current URL — no navigation needed.
      await login(email, password);
    } catch (err: any) {
      toast.error(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSsoLogin() {
    setSsoLoading(true);
    try {
      // On success the browser navigates away to the IdP; this only
      // resolves here if the request itself failed.
      await loginWithSso();
    } catch (err: any) {
      toast.error(err.message || "SSO sign-in failed");
      setSsoLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-100">
      <div className="max-w-md w-full bg-white border border-neutral-200 rounded-lg shadow-sm p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-neutral-900">autoMail</h1>
          <p className="text-neutral-600 mt-2">Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1"
            />
          </div>

          <Button type="submit" loading={loading} className="w-full">
            {loading ? "Signing in..." : "Sign In"}
          </Button>
        </form>

        {ssoEnabled && (
          <>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-neutral-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-2 text-neutral-500">or</span>
              </div>
            </div>

            <Button
              type="button"
              variant="secondary"
              loading={ssoLoading}
              className="w-full"
              onClick={handleSsoLogin}
            >
              {ssoLoading ? "Redirecting..." : "Sign in with SSO"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
