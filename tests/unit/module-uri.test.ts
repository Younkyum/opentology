import { describe, it, expect } from 'vitest';
import { stripSourceExtension, normalizeModuleUri } from '../../src/lib/module-uri.js';

describe('stripSourceExtension', () => {
  it('strips .ts extension', () => {
    expect(stripSourceExtension('src/lib/foo.ts')).toBe('src/lib/foo');
  });

  it('strips .tsx extension', () => {
    expect(stripSourceExtension('src/components/Bar.tsx')).toBe('src/components/Bar');
  });

  it('strips .js extension', () => {
    expect(stripSourceExtension('src/lib/foo.js')).toBe('src/lib/foo');
  });

  it('strips .jsx extension', () => {
    expect(stripSourceExtension('src/components/Bar.jsx')).toBe('src/components/Bar');
  });

  it('is idempotent — no extension returns unchanged', () => {
    expect(stripSourceExtension('src/lib/foo')).toBe('src/lib/foo');
  });

  it('does not strip non-source extensions', () => {
    expect(stripSourceExtension('data/config.json')).toBe('data/config.json');
    expect(stripSourceExtension('README.md')).toBe('README.md');
  });
});

describe('normalizeModuleUri', () => {
  it('produces urn:module: with stripped extension', () => {
    expect(normalizeModuleUri('src/lib/store-factory.ts')).toBe('urn:module:src/lib/store-factory');
  });

  it('handles path without extension', () => {
    expect(normalizeModuleUri('src/lib/store-factory')).toBe('urn:module:src/lib/store-factory');
  });
});
