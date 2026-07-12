import { ImapFlow } from 'imapflow';

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password?: string;
  accessToken?: string;
  // Milliseconds; imapflow defaults (90s/16s) apply when unset
  connectionTimeout?: number;
  greetingTimeout?: number;
}

export function buildImapClient(credentials: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    ...(credentials.connectionTimeout !== undefined && { connectionTimeout: credentials.connectionTimeout }),
    ...(credentials.greetingTimeout !== undefined && { greetingTimeout: credentials.greetingTimeout }),
    auth: credentials.accessToken
      ? {
          user: credentials.user,
          accessToken: credentials.accessToken,
        }
      : {
          user: credentials.user,
          pass: credentials.password!,
        },
  });
}

// Close a client without throwing, falling back to a hard close if the
// server no longer responds to LOGOUT.
export async function safeCloseImapClient(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // Connection is already gone
    }
  }
}

export async function withImapClient<T>(
  credentials: ImapCredentials,
  callback: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = buildImapClient(credentials);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await safeCloseImapClient(client);
  }
}
