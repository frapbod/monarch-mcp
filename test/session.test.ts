import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestFailedException, type MonarchMoneyOptions } from '@hakimelek/monarchmoney';

import { MonarchSession, type ClientFactory, type MonarchClient } from '../src/session.js';

interface FactoryObservation {
  readonly options: MonarchMoneyOptions;
  readonly loginOptions?: { useSavedSession?: boolean; saveSession?: boolean };
}

function fakeFactory(observations: FactoryObservation[]): ClientFactory {
  return (options) => {
    const observation: {
      options: MonarchMoneyOptions;
      loginOptions?: { useSavedSession?: boolean; saveSession?: boolean };
    } = { options };
    observations.push(observation);
    let token = options.token ?? null;
    return {
      get token() {
        return token;
      },
      login: async (
        _email?: string,
        _password?: string,
        loginOptions?: { useSavedSession?: boolean; saveSession?: boolean },
      ) => {
        if (loginOptions) observation.loginOptions = loginOptions;
        token = `token-${observations.filter((item) => item.loginOptions).length}`;
      },
    } as unknown as MonarchClient;
  };
}

test('coalesces concurrent authentication and gives reads retry-only clients', async () => {
  const observations: FactoryObservation[] = [];
  const session = new MonarchSession(
    {
      email: 'kai@example.com',
      password: 'secret',
      sessionFile: '/state/session.json',
      timeoutSeconds: 30,
    },
    fakeFactory(observations),
  );

  const tokens = await Promise.all([
    session.read(async (client) => client.token),
    session.read(async (client) => client.token),
  ]);
  assert.deepEqual(tokens, ['token-1', 'token-1']);
  assert.equal(observations.length, 3);
  assert.equal(observations.filter((item) => item.loginOptions).length, 1);
  assert.equal(observations[1]?.options.retry?.maxRetries, 2);
  assert.equal(observations[2]?.options.retry?.maxRetries, 0);
});

test('re-authenticates once after an expired saved token', async () => {
  const observations: FactoryObservation[] = [];
  const session = new MonarchSession(
    {
      email: 'kai@example.com',
      password: 'secret',
      sessionFile: '/state/session.json',
      timeoutSeconds: 30,
    },
    fakeFactory(observations),
  );
  let calls = 0;
  const token = await session.read(async (client) => {
    calls += 1;
    if (calls === 1) {
      throw new RequestFailedException('expired', { statusCode: 401 });
    }
    return client.token;
  });

  assert.equal(token, 'token-2');
  assert.equal(calls, 2);
  const logins = observations.filter((item) => item.loginOptions);
  assert.equal(logins.length, 2);
  assert.equal(logins[0]?.loginOptions?.useSavedSession, true);
  assert.equal(logins[1]?.loginOptions?.useSavedSession, false);
});
