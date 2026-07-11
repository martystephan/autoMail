export interface OAuthProviderConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  imap: {
    host: string;
    port: number;
  };
}

// Set DISABLE_MICROSOFT_OAUTH=true to remove Microsoft as a provider.
// This disables authorize/callback/refresh and hides it from the providers list.
const microsoftDisabled = process.env.DISABLE_MICROSOFT_OAUTH === "true";

const microsoftProvider: Record<string, OAuthProviderConfig> = {
  microsoft: {
    name: "Microsoft",
    clientId: process.env.MICROSOFT_CLIENT_ID || "",
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || "",
    authorizationUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
    ],
    imap: {
      host: "outlook.office365.com",
      port: 993,
    },
  },
};

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  ...(microsoftDisabled ? {} : microsoftProvider),
};

export function isValidProvider(provider: string): boolean {
  return provider in OAUTH_PROVIDERS;
}

export function getProvider(provider: string): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDERS[provider];
}
