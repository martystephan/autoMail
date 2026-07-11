import { useState, useEffect } from "react";
import type { MailAccount } from "../../api/mailAccounts";
import { startOAuthFlow, getOAuthProviders } from "../../api/oauth";
import { Button, Input, Label, Alert, Dialog } from "../ui";
import { Mail } from "lucide-react";

interface MailAccountFormProps {
  open: boolean;
  account?: MailAccount | null;
  onSubmit: (data: Partial<MailAccount>) => void;
  onCancel: () => void;
}

export default function MailAccountForm({
  open,
  account,
  onSubmit,
  onCancel,
}: MailAccountFormProps) {
  const [formData, setFormData] = useState<Partial<MailAccount>>({
    name: "",
    type: "imap",
    email: "",
    imapHost: "",
    imapPort: 993,
    password: "",
  });
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [microsoftAvailable, setMicrosoftAvailable] = useState(true);

  useEffect(() => {
    getOAuthProviders()
      .then(({ providers }) =>
        setMicrosoftAvailable(providers.some((p) => p.id === "microsoft"))
      )
      .catch(() => setMicrosoftAvailable(true));
  }, []);

  useEffect(() => {
    if (account) {
      setFormData(account);
    } else {
      setFormData({
        name: "",
        type: "imap",
        email: "",
        imapHost: "",
        imapPort: 993,
        password: "",
      });
    }
  }, [account]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const handleMicrosoftOAuth = async () => {
    setOauthLoading(true);
    setOauthError(null);

    try {
      const { authUrl } = await startOAuthFlow("microsoft");
      window.location.href = authUrl;
    } catch (error) {
      setOauthError(`Failed to start OAuth flow: ${error}`);
      setOauthLoading(false);
    }
  };

  const getTitle = () => {
    if (account && account.type === "microsoft") {
      return "Microsoft Account Details";
    }
    return account ? "Edit Mail Account" : "Add Mail Account";
  };

  if (account && account.type === "microsoft") {
    return (
      <Dialog open={open} onClose={onCancel} title={getTitle()}>
        <div className="space-y-4">
          <div className="bg-purple-50 border border-purple-200 rounded-md p-4">
            <div className="flex items-center">
              <svg
                className="h-8 w-8 text-purple-600 mr-3"
                viewBox="0 0 23 23"
                fill="currentColor"
              >
                <path d="M0 0h11v11H0zM12 0h11v11H12zM0 12h11v11H0zM12 12h11v11H12z" />
              </svg>
              <div>
                <p className="font-medium text-purple-900">{account.name}</p>
                <p className="text-sm text-purple-700">{account.email}</p>
              </div>
            </div>
          </div>

          <div className="text-sm text-neutral-600 space-y-2">
            <p>
              <span className="font-medium">IMAP Host:</span>{" "}
              {account.imapHost || "outlook.office365.com"}
            </p>
            <p>
              <span className="font-medium">Token Status:</span>{" "}
              {account.tokenExpiry ? (
                new Date(account.tokenExpiry) > new Date() ? (
                  <span className="text-green-600">Valid</span>
                ) : (
                  <span className="text-red-600">Expired</span>
                )
              ) : (
                <span className="text-neutral-400">Unknown</span>
              )}
            </p>
          </div>

          <Alert variant="warning">
            Microsoft accounts are connected via OAuth. To update the
            connection, delete this account and reconnect.
          </Alert>

          <div className="flex justify-end pt-4">
            <Button variant="secondary" onClick={onCancel}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onCancel} title={getTitle()}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label>Account Type</Label>
          <div
            className={`mt-2 grid gap-3 h-12 ${
              microsoftAvailable ? "grid-cols-2" : "grid-cols-1"
            }`}
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() => setFormData({ ...formData, type: "imap" })}
              className={
                formData.type === "imap"
                  ? "bg-blue-50! text-blue-700! border-blue-300!"
                  : ""
              }
            >
              <Mail className="size-4" />
              IMAP
            </Button>
            {microsoftAvailable && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setFormData({ ...formData, type: "microsoft" })}
                className={
                  formData.type === "microsoft"
                    ? "bg-purple-50! text-purple-700! border-purple-300!"
                    : ""
                }
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 23 23"
                  fill="currentColor"
                >
                  <path d="M0 0h11v11H0zM12 0h11v11H12zM0 12h11v11H12z" />
                </svg>
                Microsoft
              </Button>
            )}
          </div>
        </div>

        {formData.type === "imap" && (
          <>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                type="text"
                id="name"
                value={formData.name || ""}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className="mt-1"
                placeholder="My Email Account"
                required
              />
            </div>

            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                type="email"
                id="email"
                value={formData.email || ""}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                className="mt-1"
                placeholder="you@example.com"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="imapHost">IMAP Host</Label>
                <Input
                  type="text"
                  id="imapHost"
                  value={formData.imapHost || ""}
                  onChange={(e) =>
                    setFormData({ ...formData, imapHost: e.target.value })
                  }
                  className="mt-1"
                  placeholder="imap.example.com"
                  required
                />
              </div>
              <div>
                <Label htmlFor="imapPort">IMAP Port</Label>
                <Input
                  type="number"
                  id="imapPort"
                  value={formData.imapPort || 993}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      imapPort: parseInt(e.target.value),
                    })
                  }
                  className="mt-1"
                  required
                />
              </div>
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                type="password"
                id="password"
                value={formData.password || ""}
                onChange={(e) =>
                  setFormData({ ...formData, password: e.target.value })
                }
                className="mt-1"
                placeholder={account ? "(unchanged)" : "••••••••••••"}
                required={!account}
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit">{account ? "Update" : "Create"}</Button>
            </div>
          </>
        )}

        {formData.type === "microsoft" && (
          <>
            <div className="bg-purple-50 border border-purple-200 rounded-md p-4">
              <div className="flex items-start">
                <svg
                  className="h-6 w-6 text-purple-600 mt-0.5 mr-3 shrink-0"
                  viewBox="0 0 23 23"
                  fill="currentColor"
                >
                  <path d="M0 0h11v11H0zM12 0h11v11H12zM0 12h11v11H0zM12 12h11v11H12z" />
                </svg>
                <div>
                  <h3 className="font-medium text-purple-900">
                    Connect with Microsoft
                  </h3>
                  <p className="text-sm text-purple-700 mt-1">
                    Click the button below to sign in with your Microsoft
                    account. You'll be redirected to Microsoft to authorize
                    access to your mailbox.
                  </p>
                </div>
              </div>
            </div>

            {oauthError && <Alert variant="error">{oauthError}</Alert>}

            <div className="flex justify-end space-x-3 pt-4">
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <button
                type="button"
                onClick={handleMicrosoftOAuth}
                disabled={oauthLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {oauthLoading ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Connecting...
                  </>
                ) : (
                  <>
                    <svg
                      className="h-4 w-4 mr-2"
                      viewBox="0 0 23 23"
                      fill="currentColor"
                    >
                      <path d="M0 0h11v11H0zM12 0h11v11H12zM0 12h11v11H0zM12 12h11v11H12z" />
                    </svg>
                    Sign in with Microsoft
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
