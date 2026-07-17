import { toApiError } from "./errors";

const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";

export interface SetupStatus {
  needsSetup: boolean;
  ssoEnabled: boolean;
  ssoProviderId?: string;
}

// Sign-in/up/out go through the better-auth client (src/lib/authClient.ts);
// only the first-run setup check is a plain endpoint.
export async function getSetupStatus(): Promise<SetupStatus> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/setup-status`);
  } catch (error) {
    throw toApiError(error);
  }
  if (!response.ok) {
    throw new Error("Failed to check setup status");
  }
  return response.json();
}
