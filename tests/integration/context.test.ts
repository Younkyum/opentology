import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(__dirname, '../../dist/index.js');
const TMP = join(__dirname, '../../.test-tmp-context');

function run(args: string[], cwd = TMP): string {
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('opentology context', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    run(['init', 'test-ctx', '--embedded']);
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // Test group 1: context init happy path
  describe('context init happy path', () => {
    it('creates graphs, hook, and CLAUDE.md', () => {
      const output = run(['context', 'init']);

      // Config has graphs
      const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
      expect(config.graphs).toHaveProperty('context');
      expect(config.graphs).toHaveProperty('sessions');
      expect(config.graphs.context).toBe('https://opentology.dev/test-ctx/context');
      expect(config.graphs.sessions).toBe('https://opentology.dev/test-ctx/sessions');

      // Hook file exists
      expect(existsSync(join(TMP, '.opentology', 'hooks', 'session-start.mjs'))).toBe(true);

      // CLAUDE.md exists with markers
      const claudeMd = readFileSync(join(TMP, 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('OPENTOLOGY:CONTEXT:BEGIN');
      expect(claudeMd).toContain('OPENTOLOGY:CONTEXT:END');
      expect(claudeMd).toContain('https://opentology.dev/test-ctx/context');

      // Ontology file tracked
      expect(existsSync(join(TMP, '.opentology', 'ontology.ttl'))).toBe(true);
      expect(config.files).toHaveProperty('https://opentology.dev/test-ctx/context');

      // Output contains hook snippet
      expect(output).toContain('session-start.mjs');
    });
  });

  // Test group 2: idempotency
  describe('context init idempotency', () => {
    it('skips existing components on second run', () => {
      run(['context', 'init']);
      const output = run(['context', 'init']);

      expect(output).toContain('already exists');
      expect(output).toContain('already bootstrapped');
      expect(output).toContain('already exists — skipped');

      // Config unchanged (no duplicate graph entries)
      const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
      expect(Object.keys(config.graphs)).toHaveLength(2);
    });
  });

  // Test group 3: --force
  describe('context init --force', () => {
    it('regenerates hook and CLAUDE.md', () => {
      run(['context', 'init']);

      // Modify hook file
      const hookPath = join(TMP, '.opentology', 'hooks', 'session-start.mjs');
      writeFileSync(hookPath, '// modified', 'utf-8');

      run(['context', 'init', '--force']);

      // Hook should be regenerated
      const hookContent = readFileSync(hookPath, 'utf-8');
      expect(hookContent).not.toBe('// modified');
      expect(hookContent).toContain("'context', 'load'");
    });
  });

  // Test group 4: context load with sample data
  describe('context load with data', () => {
    it('returns populated JSON when data exists', () => {
      run(['context', 'init']);

      // Push a session
      const sessionTurtle = `
        @prefix otx: <https://opentology.dev/vocab#> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        <urn:session:2026-04-02> a otx:Session ;
            otx:title "Test session" ;
            otx:date "2026-04-02"^^xsd:date ;
            otx:nextTodo "Next task" .
      `;
      // Write to a temp file and push
      const ttlPath = join(TMP, 'session.ttl');
      writeFileSync(ttlPath, sessionTurtle, 'utf-8');
      run(['push', ttlPath, '--graph', 'sessions']);

      // Push an open issue
      const issueTurtle = `
        @prefix otx: <https://opentology.dev/vocab#> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        <urn:issue:42> a otx:Issue ;
            otx:title "Test bug" ;
            otx:date "2026-04-02"^^xsd:date ;
            otx:status "open" .
      `;
      const issuePath = join(TMP, 'issue.ttl');
      writeFileSync(issuePath, issueTurtle, 'utf-8');
      run(['push', issuePath, '--graph', 'context']);

      const raw = run(['context', 'load', '--format', 'json']);
      const data = JSON.parse(raw);

      expect(data.projectId).toBe('test-ctx');
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].title).toBe('Test session');
      expect(data.sessions[0].nextTodo).toBe('Next task');
      expect(data.openIssues).toHaveLength(1);
      expect(data.openIssues[0].title).toBe('Test bug');
      expect(data.meta.sessionsTripleCount).toBeGreaterThan(0);
    });
  });

  // Test group 5: context load with empty graphs
  describe('context load with empty graphs', () => {
    it('returns empty arrays', () => {
      run(['context', 'init']);

      const raw = run(['context', 'load', '--format', 'json']);
      const data = JSON.parse(raw);

      expect(data.sessions).toEqual([]);
      expect(data.openIssues).toEqual([]);
      expect(data.recentDecisions).toEqual([]);
      expect(data.warnings).toBeUndefined();
    });
  });

  // Test group 6: context status
  describe('context status', () => {
    it('shows initialized state', () => {
      run(['context', 'init']);
      const output = run(['context', 'status']);

      expect(output).toContain('initialized');
      expect(output).toContain('context');
      expect(output).toContain('sessions');
      expect(output).toContain('(exists)');
      expect(output).toContain('markers present');
    });

    it('shows not initialized state before init', () => {
      const output = run(['context', 'status']);
      expect(output).toContain('not initialized');
    });
  });

  // Test group 7: CLAUDE.md conflict handling
  describe('CLAUDE.md conflict handling', () => {
    it('creates new file when none exists', () => {
      run(['context', 'init']);
      const content = readFileSync(join(TMP, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('OPENTOLOGY:CONTEXT:BEGIN');
    });

    it('appends to existing file without markers', () => {
      writeFileSync(join(TMP, 'CLAUDE.md'), '# My Project\n\nExisting content.\n', 'utf-8');
      run(['context', 'init']);
      const content = readFileSync(join(TMP, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('# My Project');
      expect(content).toContain('Existing content.');
      expect(content).toContain('OPENTOLOGY:CONTEXT:BEGIN');
    });

    it('replaces between markers on re-init', () => {
      run(['context', 'init']);

      // Add custom content before markers
      const claudeMdPath = join(TMP, 'CLAUDE.md');
      const original = readFileSync(claudeMdPath, 'utf-8');
      writeFileSync(claudeMdPath, '# Custom Header\n\n' + original, 'utf-8');

      run(['context', 'init', '--force']);
      const updated = readFileSync(claudeMdPath, 'utf-8');

      // Custom header preserved, markers still present
      expect(updated).toContain('# Custom Header');
      expect(updated).toContain('OPENTOLOGY:CONTEXT:BEGIN');
      // Only one pair of markers
      const beginCount = (updated.match(/OPENTOLOGY:CONTEXT:BEGIN/g) || []).length;
      expect(beginCount).toBe(1);
    });
  });

  // Test group 8: hook script execution
  describe('hook script execution', () => {
    it('exits 0 when no config found', () => {
      run(['context', 'init']);
      const hookPath = join(TMP, '.opentology', 'hooks', 'session-start.mjs');

      // Execute from a dir without .opentology.json
      const emptyDir = join(TMP, 'empty');
      mkdirSync(emptyDir, { recursive: true });

      const result = execFileSync('node', [hookPath], {
        cwd: emptyDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
      // Should not throw — exits 0
      expect(typeof result).toBe('string');
    });
  });
});
