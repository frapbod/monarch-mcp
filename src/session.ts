import {
  LoginFailedException,
  MonarchMoney,
  RequestFailedException,
  type MonarchMoneyOptions,
} from '@hakimelek/monarchmoney';

import type { RuntimeConfig } from './config.js';

export type MonarchClient = MonarchMoney;
export type ClientFactory = (options: MonarchMoneyOptions) => MonarchClient;

export interface MonarchAccess {
  read<T>(operation: (client: MonarchClient) => Promise<T>): Promise<T>;
  write<T>(operation: (client: MonarchClient) => Promise<T>): Promise<T>;
}

interface ClientPair {
  readonly read: MonarchClient;
  readonly write: MonarchClient;
}

function authenticationFailed(error: unknown): boolean {
  if (error instanceof LoginFailedException) return true;
  return (
    error instanceof RequestFailedException &&
    (error.statusCode === 401 || error.statusCode === 403)
  );
}

export class MonarchSession implements MonarchAccess {
  private clients: ClientPair | undefined;
  private initialization: Promise<ClientPair> | undefined;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly createClient: ClientFactory = (options) => new MonarchMoney(options),
  ) {}

  async read<T>(operation: (client: MonarchClient) => Promise<T>): Promise<T> {
    return this.execute('read', operation);
  }

  async write<T>(operation: (client: MonarchClient) => Promise<T>): Promise<T> {
    return this.execute('write', operation);
  }

  private async execute<T>(
    kind: keyof ClientPair,
    operation: (client: MonarchClient) => Promise<T>,
  ): Promise<T> {
    const clients = await this.getClients(false);
    try {
      return await operation(clients[kind]);
    } catch (error) {
      if (!authenticationFailed(error) || this.config.token) throw error;
      const refreshed = await this.reauthenticate(clients);
      return operation(refreshed[kind]);
    }
  }

  private async getClients(forceLogin: boolean): Promise<ClientPair> {
    if (!forceLogin && this.clients) return this.clients;
    if (!forceLogin && this.initialization) return this.initialization;

    const initialization = this.createClients(forceLogin);
    this.initialization = initialization;
    try {
      const clients = await initialization;
      this.clients = clients;
      return clients;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }

  private async reauthenticate(staleClients: ClientPair): Promise<ClientPair> {
    if (this.clients !== staleClients) return this.getClients(false);
    this.clients = undefined;
    return this.getClients(true);
  }

  private async createClients(forceLogin: boolean): Promise<ClientPair> {
    let token = this.config.token;
    if (!token) {
      const authenticator = this.createClient({
        sessionFile: this.config.sessionFile,
        timeout: this.config.timeoutSeconds,
        retry: { maxRetries: 0 },
      });
      await authenticator.login(this.config.email, this.config.password, {
        useSavedSession: !forceLogin,
        saveSession: true,
        ...(this.config.mfaSecret ? { mfaSecretKey: this.config.mfaSecret } : {}),
      });
      token = authenticator.token ?? undefined;
    }

    if (!token) throw new Error('Monarch authentication completed without returning a token');

    const common = {
      token,
      timeout: this.config.timeoutSeconds,
      sessionFile: this.config.sessionFile,
    } satisfies MonarchMoneyOptions;

    return {
      read: this.createClient({
        ...common,
        retry: { maxRetries: 2, baseDelayMs: 300 },
        rateLimit: { requestsPerSecond: 8 },
      }),
      write: this.createClient({
        ...common,
        retry: { maxRetries: 0 },
        rateLimit: { requestsPerSecond: 4 },
      }),
    };
  }
}
