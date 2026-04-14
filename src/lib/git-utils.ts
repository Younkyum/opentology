import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.swift',
]);

/**
 * Returns absolute paths of source files changed since the given git ref.
 * Includes both committed changes (sinceRef..HEAD) and staged changes.
 * Returns [] on any git error (graceful fallback).
 */
export function getChangedSourceFiles(rootDir: string, sinceRef: string): string[] {
  try {
    // Verify sinceRef is reachable (guards against shallow clones or rebased history)
    execFileSync('git', ['cat-file', '-e', sinceRef], {
      cwd: rootDir, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    });

    const committed = execFileSync(
      'git', ['diff', '--name-only', sinceRef, 'HEAD'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    const staged = execFileSync(
      'git', ['diff', '--name-only', '--cached'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    const relative = [
      ...committed.split('\n').filter(Boolean),
      ...staged.split('\n').filter(Boolean),
    ];
    const unique = [...new Set(relative)];

    return unique
      .filter(f => SOURCE_EXTENSIONS.has(extname(f).toLowerCase()))
      .map(f => join(rootDir, f))
      .filter(f => existsSync(f));
  } catch {
    return [];
  }
}
