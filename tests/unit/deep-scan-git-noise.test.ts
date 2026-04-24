import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepScan } from '../../src/lib/deep-scanner.js';

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('deepScan git boundary', () => {
  it('does not emit git fatal noise when scanning a non-git directory', async () => {
    const root = makeTempDir('opentology-nogit');
    // Make it look like a project with at least one supported file.
    writeFileSync(join(root, 'a.ts'), 'export const x = 1;\n', 'utf-8');

    const writes: string[] = [];

    type StderrWrite = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error) => void), cb?: (err?: Error) => void) => boolean;
    const stderrRef = process.stderr as unknown as { write: StderrWrite };
    const orig: StderrWrite = stderrRef.write.bind(process.stderr);

    // Intercept stderr writes in-process.
    const hook: StderrWrite = (chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      // Do not forward to real stderr; keep test output clean.
      return true;
    };

    stderrRef.write = hook;

    try {
      const result = await deepScan(root, { maxFiles: 50, timeoutMs: 5000 });
      expect(result.deepScanAvailable).toBe(true);
    } finally {
      stderrRef.write = orig;
    }

    expect(writes.join('')).not.toMatch(/fatal: not a git repository/i);
  });
});
