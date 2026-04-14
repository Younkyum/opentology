import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readScanState, writeScanState, getCurrentGitRef, ScanState } from '../../src/lib/scan-state.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'scan-state-'));
  await mkdir(join(tempDir, '.opentology'), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('readScanState', () => {
  it('returns null when last-scan.json does not exist', () => {
    const result = readScanState(tempDir);
    expect(result).toBeNull();
  });

  it('returns parsed state when last-scan.json exists', () => {
    const state: ScanState = {
      lastScanRef: 'abc123',
      lastScanAt: '2026-04-14T00:00:00.000Z',
      scannedFiles: ['src/foo.ts'],
    };
    writeFileSync(join(tempDir, '.opentology', 'last-scan.json'), JSON.stringify(state));

    const result = readScanState(tempDir);
    expect(result).toEqual(state);
  });

  it('returns null when last-scan.json is malformed', () => {
    writeFileSync(join(tempDir, '.opentology', 'last-scan.json'), 'not-json');
    const result = readScanState(tempDir);
    expect(result).toBeNull();
  });
});

describe('writeScanState', () => {
  it('creates last-scan.json with the given state', () => {
    const state: ScanState = {
      lastScanRef: 'def456',
      lastScanAt: '2026-04-14T01:00:00.000Z',
      scannedFiles: ['src/bar.ts', 'src/baz.py'],
    };
    writeScanState(tempDir, state);

    const statePath = join(tempDir, '.opentology', 'last-scan.json');
    expect(existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(parsed).toEqual(state);
  });

  it('overwrites existing last-scan.json', () => {
    const first: ScanState = { lastScanRef: 'aaa', lastScanAt: '2026-01-01T00:00:00.000Z', scannedFiles: [] };
    const second: ScanState = { lastScanRef: 'bbb', lastScanAt: '2026-01-02T00:00:00.000Z', scannedFiles: ['x.ts'] };

    writeScanState(tempDir, first);
    writeScanState(tempDir, second);

    const result = readScanState(tempDir);
    expect(result).toEqual(second);
  });
});

describe('getCurrentGitRef', () => {
  it('returns HEAD sha in a real git repo', () => {
    // Use the actual repo (cwd)
    const ref = getCurrentGitRef(process.cwd());
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns "HEAD" fallback when not a git repo', async () => {
    // tempDir is not a git repo
    const result = getCurrentGitRef(tempDir);
    expect(result).toBe('HEAD');
  });
});
