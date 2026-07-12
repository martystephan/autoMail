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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, needsSetup } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-100">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (needsSetup) {
    return <Navigate to="/register" replace />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AuthRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-100">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function RegisterRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, needsSetup } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-100">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  // Check for token in localStorage as backup - user state might not be set yet
  const hasToken = !!localStorage.getItem("authToken");

  if (user || hasToken) {
    return <Navigate to="/" replace />;
  }

  if (!needsSetup) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Auth routes */}
      <Route
        path="/login"
        element={
          <AuthRoute>
            <LoginPage />
          </AuthRoute>
        }
      />
      <Route
        path="/register"
        element={
          <RegisterRoute>
            <RegisterPage />
          </RegisterRoute>
        }
      />

      {/* OAuth callback without Layout wrapper */}
      <Route path="/oauth/callback" element={<OAuthCallbackPage />} />

      {/* Protected routes with Layout */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout>
              <MailAccountsPage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/automation-flows"
        element={
          <ProtectedRoute>
            <Layout>
              <AutomationFlowsPage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/migration"
        element={
          <ProtectedRoute>
            <Layout>
              <MigrationPage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/archive"
        element={
          <ProtectedRoute>
            <Layout>
              <ArchivePage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/connection-test"
        element={
          <ProtectedRoute>
            <Layout>
              <ConnectionTestPage />
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <AppRoutes />
        <Toaster position="bottom-center" richColors />
      </AuthProvider>
    </Router>
  );
}

export default App;
