import { toApiError } from './errors';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export async function apiRequest<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
  } catch (error) {
    throw toApiError(error);
  }

  if (!response.ok) {
    if (response.status === 401) {
      // Reload in place: the AuthGate shows the login page and the current
      // URL is restored after signing in again
      window.location.reload();
      throw new Error('Session expired');
    }
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Fetch a file from an authenticated endpoint as a blob, so downloads share
// the same 401 handling as regular API calls.
export async function apiFetchBlob(endpoint: string): Promise<Blob> {
  const url = `${API_BASE_URL}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    throw toApiError(error);
  }

  if (!response.ok) {
    if (response.status === 401) {
      window.location.reload();
      throw new Error('Session expired');
    }
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.blob();
}

// Download a file from an authenticated endpoint via the browser's save flow
export async function apiDownload(endpoint: string, filename: string): Promise<void> {
  const blob = await apiFetchBlob(endpoint);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
