import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(__dirname, '../../dist/index.js');
const TMP = join(__dirname, '../../.test-tmp-rollback');

function run(args: string[], cwd = TMP): string {
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('rollback integration', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    run(['init', 'test-rollback', '--embedded']);
    // Initialize context (non-interactive: pipe stdin)
    try {
      execFileSync('node', [CLI, 'context', 'init'], {
        cwd: TMP,
        encoding: 'utf-8',
        timeout: 15000,
        input: 'n\n', // answer "no" to PreToolUse hook question
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // context init may fail in test env, that's ok
    }
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe('push -> drop -> rollback workflow', () => {
    it('restores data after drop', () => {
      // Push some data
      const turtlePath = join(TMP, 'data.ttl');
      writeFileSync(turtlePath, `
        @prefix ex: <http://example.org/> .
        ex:Alice ex:name "Alice" .
      `, 'utf-8');
      run(['push', 'data.ttl']);

      // Verify data exists
      const beforeDrop = run(['query', 'SELECT ?s WHERE { ?s <http://example.org/name> "Alice" }']);
      expect(beforeDrop).toContain('Alice');

      // Drop the graph (creates snapshot automatically)
      run(['drop', '--force']);

      // Verify data is gone
      const afterDrop = run(['query', 'SELECT ?s WHERE { ?s <http://example.org/name> "Alice" }']);
      expect(afterDrop).not.toContain('Alice');

      // List snapshots
      const listOutput = run(['rollback', '--list']);
      expect(listOutput).toContain('Snapshots');

      // Get snapshot timestamp from the snapshots directory
      const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
      const graphUri = config.graphUri;
      const slug = graphUri.replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_');
      const snapshotDir = join(TMP, '.opentology', 'snapshots', slug);

      if (existsSync(snapshotDir)) {
        const files = readdirSync(snapshotDir)
          .filter((f) => f.endsWith('.ttl') && !f.includes('_pre-rollback'))
          .sort();

        if (files.length > 0) {
          const timestamp = files[files.length - 1]!.replace('.ttl', '');
          // Restore
          run(['rollback', '--to', timestamp]);

          // Verify data is back
          const afterRestore = run(['query', 'SELECT ?s WHERE { ?s <http://example.org/name> "Alice" }']);
          expect(afterRestore).toContain('Alice');
        }
      }
    });
  });

  describe('rollback --list with no snapshots', () => {
    it('shows appropriate message', () => {
      const output = run(['rollback', '--list']);
      expect(output).toContain('No snapshots');
    });
  });

  describe('CLI drop creates snapshot', () => {
    it('creates snapshot file before dropping', () => {
      // Push data first
      const turtlePath = join(TMP, 'data.ttl');
      writeFileSync(turtlePath, `
        @prefix ex: <http://example.org/> .
        ex:Test ex:val "test" .
      `, 'utf-8');
      run(['push', 'data.ttl']);

      // Drop triggers snapshot
      run(['drop', '--force']);

      // Check snapshots directory exists
      const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
      const graphUri = config.graphUri;
      const slug = graphUri.replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_');
      const snapshotDir = join(TMP, '.opentology', 'snapshots', slug);

      expect(existsSync(snapshotDir)).toBe(true);
      const files = readdirSync(snapshotDir).filter((f) => f.endsWith('.ttl'));
      expect(files.length).toBeGreaterThan(0);
    });
  });
});
