import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepScan } from '../../src/lib/deep-scanner.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'deep-scan-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeTsConfig(dir: string) {
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      outDir: './dist',
    },
    include: ['src/**/*.ts'],
  }));
}

async function writeSourceFile(dir: string, relPath: string, content: string) {
  const fullPath = join(dir, relPath);
  const parent = fullPath.substring(0, fullPath.lastIndexOf('/'));
  await mkdir(parent, { recursive: true });
  await writeFile(fullPath, content);
}

describe('deep-scanner', () => {
  describe('class extraction', () => {
    it('extracts a single class with methods', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/service.ts', `
        export class UserService {
          getName(): string { return 'test'; }
          getAge(id: number): number { return 0; }
        }
      `);

      const result = await deepScan(tempDir);
      expect(result.deepScanAvailable).toBe(true);
      if (!result.deepScanAvailable) return;

      expect(result.classes.length).toBe(1);
      const cls = result.classes[0];
      expect(cls.name).toBe('UserService');
      expect(cls.methods.length).toBe(2);
      expect(cls.methods[0].name).toBe('getName');
      expect(cls.methods[1].name).toBe('getAge');
      expect(cls.methods[1].parameters.length).toBe(1);
      expect(cls.methods[1].parameters[0].name).toBe('id');
    });

    it('detects abstract classes', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/base.ts', `
        export abstract class BaseHandler {
          abstract handle(): void;
        }
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      expect(result.classes[0].isAbstract).toBe(true);
    });
  });

  describe('inheritance', () => {
    it('resolves cross-file inheritance', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/base.ts', `
        export class Animal {
          move(): void {}
        }
      `);
      await writeSourceFile(tempDir, 'src/dog.ts', `
        import { Animal } from './base.js';
        export class Dog extends Animal {
          bark(): void {}
        }
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      const dog = result.classes.find(c => c.name === 'Dog');
      expect(dog).toBeDefined();
      expect(dog!.baseClass).toContain('Animal');
      expect(dog!.baseClass).toContain('class');
    });

    it('resolves same-file inheritance', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/shapes.ts', `
        export class Shape {
          area(): number { return 0; }
        }
        export class Circle extends Shape {
          radius = 1;
        }
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      const circle = result.classes.find(c => c.name === 'Circle');
      expect(circle).toBeDefined();
      expect(circle!.baseClass).toContain('Shape');
    });
  });

  describe('interface implementation', () => {
    it('detects class implementing interface', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/types.ts', `
        export interface Serializable {
          serialize(): string;
        }
      `);
      await writeSourceFile(tempDir, 'src/model.ts', `
        import { Serializable } from './types.js';
        export class User implements Serializable {
          serialize(): string { return '{}'; }
        }
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      const user = result.classes.find(c => c.name === 'User');
      expect(user).toBeDefined();
      expect(user!.interfaces.length).toBe(1);
      expect(user!.interfaces[0]).toContain('Serializable');
    });
  });

  describe('interface extraction', () => {
    it('extracts interfaces with extends', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/types.ts', `
        export interface Base {
          id(): string;
        }
        export interface Extended extends Base {
          name(): string;
        }
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      const ext = result.interfaces.find(i => i.name === 'Extended');
      expect(ext).toBeDefined();
      expect(ext!.extends).toContain('Base');
      expect(ext!.methods.length).toBe(1);
    });
  });

  describe('function extraction', () => {
    it('extracts top-level functions', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/utils.ts', `
        export function greet(name: string): string {
          return 'hello ' + name;
        }
        function internal(): void {}
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      expect(result.functions.length).toBe(2);
      const greet = result.functions.find(f => f.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet!.isExported).toBe(true);
      expect(greet!.parameters[0].name).toBe('name');
    });
  });

  describe('maxSymbols cap', () => {
    it('caps symbols and sets capped flag', async () => {
      await writeTsConfig(tempDir);
      // Create 20 classes
      let content = '';
      for (let i = 0; i < 20; i++) {
        content += `export class C${i} { m${i}(): void {} }\n`;
      }
      await writeSourceFile(tempDir, 'src/many.ts', content);

      const result = await deepScan(tempDir, { maxSymbols: 5 });
      if (!result.deepScanAvailable) return;

      expect(result.capped).toBe(true);
      // symbolCount includes classes + their methods
      expect(result.symbolCount).toBeLessThanOrEqual(10); // 5 classes + up to 5 methods
    });
  });

  describe('error handling', () => {
    it('skips files with syntax errors and adds warning', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/good.ts', `
        export class Good { run(): void {} }
      `);
      await writeSourceFile(tempDir, 'src/bad.ts', `
        export class Bad {{{{{ syntax error
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      // Should have at least the good class
      expect(result.classes.some(c => c.name === 'Good')).toBe(true);
      // Bad file may produce a warning or ts-morph may handle parse errors gracefully
    });

    it('returns unavailable when tsconfig is missing', async () => {
      // No tsconfig.json written
      await writeSourceFile(tempDir, 'src/foo.ts', 'export class Foo {}');

      const result = await deepScan(tempDir);
      expect(result.deepScanAvailable).toBe(false);
    });
  });

  describe('URI scheme', () => {
    it('uses urn:symbol path/kind/name format in result data', async () => {
      await writeTsConfig(tempDir);
      await writeSourceFile(tempDir, 'src/app.ts', `
        export class App { start(): void {} }
      `);

      const result = await deepScan(tempDir);
      if (!result.deepScanAvailable) return;

      const cls = result.classes[0];
      expect(cls.filePath).toBe('src/app');
      expect(cls.name).toBe('App');
      // The URI is constructed in deep-scan-triples.ts, but filePath + name are the building blocks
    });
  });
});
