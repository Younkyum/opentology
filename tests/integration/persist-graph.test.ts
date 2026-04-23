import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(__dirname, '../../.test-tmp-persist');
const GRAPH_URI = 'https://opentology.dev/test-persist/context';

describe('persistGraph', () => {
  let persistGraph: typeof import('../../src/lib/persist.js').persistGraph;
  let EmbeddedAdapter: typeof import('../../src/lib/embedded-adapter.js').EmbeddedAdapter;
  let originalCwd: string;

  beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(TMP, '.opentology'), { recursive: true });

    // Write a minimal config
    writeFileSync(
      join(TMP, '.opentology.json'),
      JSON.stringify({
        projectId: 'test-persist',
        mode: 'embedded',
        graphUri: 'https://opentology.dev/test-persist',
        graphs: { context: GRAPH_URI },
      }),
      'utf-8',
    );

    // Switch cwd so loadConfig/saveConfig find the test config
    originalCwd = process.cwd();
    process.chdir(TMP);

    // Dynamic import to pick up the test cwd
    const serverMod = await import('../../src/lib/persist.js');
    persistGraph = serverMod.persistGraph;
    const adapterMod = await import('../../src/lib/embedded-adapter.js');
    EmbeddedAdapter = adapterMod.EmbeddedAdapter;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(TMP, { recursive: true, force: true });
  });

  it('writes graph data to .opentology/data/ and tracks in config', async () => {
    const adapter = new EmbeddedAdapter();
    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:Alice ex:name "Alice" .
    `;
    adapter.loadTurtleIntoGraph(turtle, GRAPH_URI);

    const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
    await persistGraph(adapter, config, GRAPH_URI);

    // Check .opentology/data/ directory was created with a .ttl file
    const dataDir = join(TMP, '.opentology', 'data');
    expect(existsSync(dataDir)).toBe(true);

    // Find the generated .ttl file
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dataDir).filter((f) => f.endsWith('.ttl'));
    expect(files.length).toBe(1);

    // Check the file contains Alice
    const content = readFileSync(join(dataDir, files[0]!), 'utf-8');
    expect(content).toContain('Alice');

    // Check config was updated with tracked file
    const updatedConfig = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
    expect(updatedConfig.files).toBeDefined();
    expect(updatedConfig.files[GRAPH_URI]).toBeDefined();
    expect(updatedConfig.files[GRAPH_URI].length).toBe(1);
    expect(updatedConfig.files[GRAPH_URI][0]).toContain('.opentology/data/');
  });

  it('skips persist for non-embedded mode', async () => {
    const adapter = new EmbeddedAdapter();
    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:Bob ex:age "30" .
    `;
    adapter.loadTurtleIntoGraph(turtle, GRAPH_URI);

    const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
    config.mode = 'http';
    await persistGraph(adapter, config, GRAPH_URI);

    // No data dir should be created
    const dataDir = join(TMP, '.opentology', 'data');
    expect(existsSync(dataDir)).toBe(false);
  });

  it('writes empty file gracefully after drop', async () => {
    const adapter = new EmbeddedAdapter();
    // Insert then drop
    adapter.loadTurtleIntoGraph(
      `@prefix ex: <http://example.org/> . ex:X ex:y "z" .`,
      GRAPH_URI,
    );
    await adapter.dropGraph(GRAPH_URI);

    const config = JSON.parse(readFileSync(join(TMP, '.opentology.json'), 'utf-8'));
    await persistGraph(adapter, config, GRAPH_URI);

    // Data dir may or may not exist, but no crash
    const dataDir = join(TMP, '.opentology', 'data');
    if (existsSync(dataDir)) {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(dataDir).filter((f) => f.endsWith('.ttl'));
      // Either no file or empty file — both are fine
      if (files.length > 0) {
        const content = readFileSync(join(dataDir, files[0]!), 'utf-8');
        expect(content.trim()).toBe('');
      }
    }
  });
});
