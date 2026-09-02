import { join } from 'node:path';

export interface RuntimeConfig {
  readonly email?: string;
  readonly password?: string;
  readonly mfaSecret?: string;
  readonly token?: string;
  readonly sessionFile: string;
  readonly timeoutSeconds: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const token = env.MONARCH_TOKEN?.trim() || undefined;
  const email = env.MONARCH_EMAIL?.trim() || undefined;
  const password = env.MONARCH_PASSWORD || undefined;

  if (!token && (!email || !password)) {
    throw new Error(
      'Monarch authentication requires MONARCH_TOKEN or both MONARCH_EMAIL and MONARCH_PASSWORD',
    );
  }

  const sessionDir = env.MONARCH_SESSION_DIR?.trim() || join(process.cwd(), '.mm');
  return {
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
    ...(env.MONARCH_MFA_SECRET ? { mfaSecret: env.MONARCH_MFA_SECRET } : {}),
    ...(token ? { token } : {}),
    sessionFile: join(sessionDir, 'session.json'),
    timeoutSeconds: positiveInteger(env.MONARCH_TIMEOUT_SECONDS, 30),
  };
}
