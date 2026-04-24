import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPackageVersion } from '../../src/lib/version.js';
import { createProgram } from '../../src/cli.js';
import { getMcpServerIdentity } from '../../src/mcp/server.js';

function readPackageJsonVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '';
}

describe('version coherence', () => {
  it('getPackageVersion matches package.json', () => {
    expect(getPackageVersion()).toBe(readPackageJsonVersion());
  });

  it('CLI program version matches package.json', () => {
    const program = createProgram();
    const internal = program as unknown as { _version?: string };
    expect(internal._version).toBe(readPackageJsonVersion());
  });

  it('MCP server version matches package.json', () => {
    expect(getMcpServerIdentity().version).toBe(readPackageJsonVersion());
  });
});
