import { toApiError } from './errors';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

function getAuthToken(): string | null {
  return localStorage.getItem('authToken');
}

export async function apiRequest<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = getAuthToken();

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
      },
    });
  } catch (error) {
    throw toApiError(error);
  }

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('authToken');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Fetch a file from an authenticated endpoint as a blob. An <a href> cannot
// carry the Authorization header, so downloads go through fetch.
export async function apiFetchBlob(endpoint: string): Promise<Blob> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = getAuthToken();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (error) {
    throw toApiError(error);
  }

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('authToken');
      window.location.href = '/login';
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
