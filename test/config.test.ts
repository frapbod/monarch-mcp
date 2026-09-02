import assert from 'node:assert/strict';
import test from 'node:test';

import { readConfig } from '../src/config.js';

test('accepts token authentication without credentials', () => {
  const config = readConfig({ MONARCH_TOKEN: 'token', MONARCH_SESSION_DIR: '/state' });
  assert.equal(config.token, 'token');
  assert.equal(config.sessionFile, '/state/session.json');
  assert.equal(config.timeoutSeconds, 30);
});

test('accepts credential authentication and a custom timeout', () => {
  const config = readConfig({
    MONARCH_EMAIL: 'kai@example.com',
    MONARCH_PASSWORD: 'secret',
    MONARCH_MFA_SECRET: 'totp',
    MONARCH_TIMEOUT_SECONDS: '45',
  });
  assert.equal(config.email, 'kai@example.com');
  assert.equal(config.mfaSecret, 'totp');
  assert.equal(config.timeoutSeconds, 45);
});

test('rejects missing authentication', () => {
  assert.throws(() => readConfig({}), /MONARCH_TOKEN/);
});
