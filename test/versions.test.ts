import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

interface PackageMetadata {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

test('version index matches the locked package declarations', () => {
  const versions = Object.fromEntries(
    readFileSync(new URL('../versions.env', import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  );
  const metadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata;

  assert.equal(metadata.dependencies['@modelcontextprotocol/server'], versions.MCP_SERVER_VERSION);
  assert.equal(metadata.dependencies['@hakimelek/monarchmoney'], versions.MONARCH_CLIENT_VERSION);
  assert.equal(metadata.devDependencies.typescript, versions.TYPESCRIPT_VERSION);
  assert.equal(metadata.devDependencies['@biomejs/biome'], versions.BIOME_VERSION);
});
