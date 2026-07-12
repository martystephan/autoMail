import { toApiError } from "./errors";

const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw toApiError(error);
  }
}

export interface User {
  id: number;
  username: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface SetupStatus {
  needsSetup: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const response = await authFetch(`${API_BASE_URL}/auth/setup-status`);
  if (!response.ok) {
    throw new Error("Failed to check setup status");
  }
  return response.json();
}

export async function register(
  username: string,
  password: string
): Promise<AuthResponse> {
  const response = await authFetch(`${API_BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Registration failed");
  }

  return response.json();
}

export async function login(
  username: string,
  password: string
): Promise<AuthResponse> {
  const response = await authFetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Login failed");
  }

  return response.json();
}

export async function getCurrentUser(token: string): Promise<{ user: User }> {
  const response = await authFetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error("Invalid token");
  }

  return response.json();
}
