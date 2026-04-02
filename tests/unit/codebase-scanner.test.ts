import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanCodebase } from '../../src/lib/codebase-scanner.js';
import type { CodebaseSnapshot, DirectoryNode } from '../../src/lib/codebase-scanner.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'opentology-scanner-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('codebase-scanner', () => {
  describe('package.json scanning', () => {
    it('reads package.json fields correctly', async () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        description: 'A test project',
        scripts: { build: 'tsc', test: 'vitest' },
        dependencies: { express: '^4.0.0' },
        devDependencies: { typescript: '^5.0.0' },
        engines: { node: '>=20' },
      }));

      const snapshot = await scanCodebase(tempDir);
      expect(snapshot.packageJson).not.toBeNull();
      expect(snapshot.packageJson!.name).toBe('test-project');
      expect(snapshot.packageJson!.version).toBe('1.0.0');
      expect(snapshot.packageJson!.scripts).toEqual({ build: 'tsc', test: 'vitest' });
      expect(snapshot.packageJson!.dependencies).toEqual({ express: '^4.0.0' });
      expect(snapshot.packageJson!.devDependencies).toEqual({ typescript: '^5.0.0' });
      expect(snapshot.packageJson!.engines).toEqual({ node: '>=20' });
    });
  });

  describe('tsconfig scanning', () => {
    it('reads tsconfig.json compilerOptions correctly', async () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          strict: true,
          paths: { '@/*': ['./src/*'] },
        },
      }));

      const snapshot = await scanCodebase(tempDir);
      expect(snapshot.tsconfig).not.toBeNull();
      expect(snapshot.tsconfig!.target).toBe('ES2022');
      expect(snapshot.tsconfig!.module).toBe('NodeNext');
      expect(snapshot.tsconfig!.strict).toBe(true);
      expect(snapshot.tsconfig!.paths).toEqual({ '@/*': ['./src/*'] });
    });
  });

  describe('directory tree', () => {
    it('generates structured DirectoryNode[] tree', async () => {
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src', 'index.ts'), 'export {}');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const snapshot = await scanCodebase(tempDir);
      expect(Array.isArray(snapshot.directoryTree)).toBe(true);

      const srcNode = snapshot.directoryTree.find((n: DirectoryNode) => n.name === 'src');
      expect(srcNode).toBeDefined();
      expect(srcNode!.type).toBe('directory');
      expect(srcNode!.children).toBeDefined();

      const indexNode = srcNode!.children!.find((n: DirectoryNode) => n.name === 'index.ts');
      expect(indexNode).toBeDefined();
      expect(indexNode!.type).toBe('file');
    });

    it('limits depth to 3 levels', async () => {
      // Create 5 levels deep: a/b/c/d/e
      const deep = join(tempDir, 'a', 'b', 'c', 'd', 'e');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'deep.txt'), 'deep file');

      const snapshot = await scanCodebase(tempDir);

      // Level 0: a, Level 1: b, Level 2: c — should stop here (depth 3)
      const a = snapshot.directoryTree.find((n: DirectoryNode) => n.name === 'a');
      expect(a).toBeDefined();
      const b = a!.children!.find((n: DirectoryNode) => n.name === 'b');
      expect(b).toBeDefined();
      const c = b!.children!.find((n: DirectoryNode) => n.name === 'c');
      expect(c).toBeDefined();
      // At depth 3, children should be empty (no d)
      expect(c!.children).toEqual([]);
    });
  });

  describe('entry point truncation', () => {
    it('truncates entry point contents to ~150 lines', async () => {
      const longContent = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join('\n');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src', 'index.ts'), longContent);
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        main: './dist/index.js',
      }));

      const snapshot = await scanCodebase(tempDir);
      const ep = snapshot.entryPoints.find(e => e.path.includes('index.ts'));
      if (ep) {
        const lines = ep.content.split('\n');
        // Should be ~150 lines + truncation marker
        expect(lines.length).toBeLessThanOrEqual(152);
      }
    });
  });

  describe('missing files', () => {
    it('returns null fields when no package.json, tsconfig, or README', async () => {
      const snapshot = await scanCodebase(tempDir);
      expect(snapshot.packageJson).toBeNull();
      expect(snapshot.tsconfig).toBeNull();
      expect(snapshot.readme).toBeNull();
      expect(snapshot.directoryTree).toEqual([]);
      expect(snapshot.entryPoints).toEqual([]);
      expect(snapshot.detectedImports).toEqual([]);
    });
  });

  describe('hardcoded exclusions', () => {
    it('excludes .git, node_modules, dist from tree', async () => {
      mkdirSync(join(tempDir, '.git'));
      writeFileSync(join(tempDir, '.git', 'config'), 'git config');
      mkdirSync(join(tempDir, 'node_modules'));
      writeFileSync(join(tempDir, 'node_modules', 'pkg.json'), '{}');
      mkdirSync(join(tempDir, 'dist'));
      writeFileSync(join(tempDir, 'dist', 'index.js'), 'compiled');
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src', 'app.ts'), 'export {}');

      const snapshot = await scanCodebase(tempDir);
      const names = snapshot.directoryTree.map((n: DirectoryNode) => n.name);
      expect(names).not.toContain('.git');
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('dist');
      expect(names).toContain('src');
    });
  });

  describe('byte cap enforcement', () => {
    it('sets truncated: true when snapshot exceeds maxSnapshotBytes', async () => {
      // Create a project with enough data to exceed a very small byte cap
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'big-project',
        description: 'A'.repeat(500),
        scripts: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`script${i}`, `command ${i}`])),
        dependencies: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`dep${i}`, `^${i}.0.0`])),
      }));
      writeFileSync(join(tempDir, 'README.md'), 'README\n'.repeat(100));
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const x = 1;\n'.repeat(200));

      // Use a very small byte cap to force truncation
      const snapshot = await scanCodebase(tempDir, 1024);
      expect(snapshot.truncated).toBe(true);
    });
  });
});
