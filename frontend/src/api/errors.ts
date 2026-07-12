const NETWORK_ERROR_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";

export function toApiError(error: unknown): Error {
  if (error instanceof TypeError) {
    // fetch() rejects with a TypeError when no HTTP response is received
    // (for example when the API is offline, unreachable, or blocked by CORS).
    return new Error(NETWORK_ERROR_MESSAGE, { cause: error });
  }

  return error instanceof Error ? error : new Error("Something went wrong. Please try again.");
}

