import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to mock process.cwd() before importing config module
// so configPath() resolves to our temp directory.
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'opentology-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

// Dynamic import to pick up the mocked cwd each time
async function importConfig() {
  // Clear module cache so each test gets fresh imports with the mocked cwd
  const mod = await import('../../src/lib/config.js');
  return mod;
}

describe('config', () => {
  describe('saveConfig + loadConfig round-trip', () => {
    it('writes JSON and reads it back correctly', async () => {
      const { saveConfig, loadConfig } = await importConfig();
      const config = {
        projectId: 'test-project',
        endpoint: 'http://localhost:7878',
        graphUri: 'http://example.org/graph',
      };

      saveConfig(config);

      // Verify the file was actually written
      const filePath = join(tempDir, '.opentology.json');
      expect(existsSync(filePath)).toBe(true);

      // Verify JSON content
      const raw = readFileSync(filePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual(config);

      // Verify loadConfig returns same data plus the default mode field
      const loaded = loadConfig();
      expect(loaded).toEqual({ ...config, mode: 'http' });
    });
  });

  describe('loadConfig', () => {
    it('throws when no config file exists', async () => {
      const { loadConfig } = await importConfig();
      expect(() => loadConfig()).toThrow(/Config file not found/);
    });
  });

  describe('configExists', () => {
    it('returns false when no config file exists', async () => {
      const { configExists } = await importConfig();
      expect(configExists()).toBe(false);
    });

    it('returns true after saving a config', async () => {
      const { saveConfig, configExists } = await importConfig();
      saveConfig({
        projectId: 'proj',
        endpoint: 'http://localhost:7878',
        graphUri: 'http://example.org/g',
      });
      expect(configExists()).toBe(true);
    });
  });
});
