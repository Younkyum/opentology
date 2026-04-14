import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanState {
  lastScanRef: string;
  lastScanAt: string;
  scannedFiles: string[];
}

const STATE_FILE = '.opentology/last-scan.json';

export function readScanState(rootDir: string): ScanState | null {
  const stateFile = join(rootDir, STATE_FILE);
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8')) as ScanState;
  } catch {
    return null;
  }
}

export function writeScanState(rootDir: string, state: ScanState): void {
  const stateFile = join(rootDir, STATE_FILE);
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

export function getCurrentGitRef(rootDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'HEAD';
  }
}
