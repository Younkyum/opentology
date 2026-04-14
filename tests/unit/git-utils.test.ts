import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { getChangedSourceFiles } from '../../src/lib/git-utils.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'git-utils-'));
  execSync('git init', { cwd: tempDir });
  execSync('git config user.email "test@test.com"', { cwd: tempDir });
  execSync('git config user.name "Test"', { cwd: tempDir });
  // initial commit so HEAD exists
  await writeFile(join(tempDir, 'README.md'), '# test');
  execSync('git add .', { cwd: tempDir });
  execSync('git commit -m "init"', { cwd: tempDir });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('getChangedSourceFiles', () => {
  it('returns empty array when no files changed since HEAD', () => {
    const result = getChangedSourceFiles(tempDir, 'HEAD');
    expect(result).toEqual([]);
  });

  it('returns changed source files since a ref', async () => {
    const sha = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf-8' }).trim();

    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src/foo.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "add foo"', { cwd: tempDir });

    const result = getChangedSourceFiles(tempDir, sha);
    expect(result.length).toBe(1);
    expect(result[0]).toMatch(/src\/foo\.ts$/);
  });

  it('filters out non-source files', async () => {
    const sha = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf-8' }).trim();

    await writeFile(join(tempDir, 'config.json'), '{}');
    await writeFile(join(tempDir, 'notes.md'), '# notes');
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "add non-source"', { cwd: tempDir });

    const result = getChangedSourceFiles(tempDir, sha);
    expect(result).toEqual([]);
  });

  it('includes multiple source extensions', async () => {
    const sha = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf-8' }).trim();

    await writeFile(join(tempDir, 'main.py'), 'print("hello")');
    await writeFile(join(tempDir, 'server.go'), 'package main');
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "add py and go"', { cwd: tempDir });

    const result = getChangedSourceFiles(tempDir, sha);
    expect(result.length).toBe(2);
    expect(result.some(f => f.endsWith('.py'))).toBe(true);
    expect(result.some(f => f.endsWith('.go'))).toBe(true);
  });

  it('returns empty array on git error (graceful fallback)', () => {
    const result = getChangedSourceFiles('/nonexistent/path', 'HEAD');
    expect(result).toEqual([]);
  });

  it('returns only files that exist on disk (filters deleted files)', async () => {
    const sha = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf-8' }).trim();

    await writeFile(join(tempDir, 'app.ts'), 'export {}');
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "add app"', { cwd: tempDir });

    // Delete the file and commit the deletion
    execSync('git rm app.ts', { cwd: tempDir });
    execSync('git commit -m "remove app"', { cwd: tempDir });

    const result = getChangedSourceFiles(tempDir, sha);
    // app.ts was changed but deleted — should not appear
    expect(result.every(f => !f.endsWith('app.ts'))).toBe(true);
  });
});
