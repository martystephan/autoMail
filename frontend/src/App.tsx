import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Layout from "./components/Layout/Layout";
import MailAccountsPage from "./pages/MailAccountsPage";
import AutomationFlowsPage from "./pages/AutomationFlowsPage";
import MigrationPage from "./pages/MigrationPage";
import ArchivePage from "./pages/ArchivePage";
import ConnectionTestPage from "./pages/ConnectionTestPage";
import OAuthCallbackPage from "./pages/OAuthCallbackPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";

// Single gate instead of per-route guards: exactly one of setup / login / app
// is rendered based on auth state, so wrong combinations (login page while no
// account exists, register page while one does) can't be reached via the URL.
// The current location is untouched — after signing in you land where you were.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading, needsSetup } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-100">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (needsSetup) {
    return <RegisterPage />;
  }

  if (!user) {
    return <LoginPage />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      {/* OAuth callback without Layout wrapper */}
      <Route path="/oauth/callback" element={<OAuthCallbackPage />} />

      <Route
        path="/"
        element={
          <Layout>
            <MailAccountsPage />
          </Layout>
        }
      />
      <Route
        path="/automation-flows"
        element={
          <Layout>
            <AutomationFlowsPage />
          </Layout>
        }
      />
      <Route
        path="/migration"
        element={
          <Layout>
            <MigrationPage />
          </Layout>
        }
      />
      <Route
        path="/archive"
        element={
          <Layout>
            <ArchivePage />
          </Layout>
        }
      />
      <Route
        path="/connection-test"
        element={
          <Layout>
            <ConnectionTestPage />
          </Layout>
        }
      />
      {/* Old auth URLs (bookmarks, the API client's 401 redirect target in
          older builds) just go home — the gate decides what to show there */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <AuthGate>
          <AppRoutes />
        </AuthGate>
        <Toaster position="bottom-center" richColors />
      </AuthProvider>
    </Router>
  );
}

export default App;
