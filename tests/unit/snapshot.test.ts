import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EmbeddedAdapter } from '../../src/lib/embedded-adapter.js';
import {
  snapshotGraph,
  listSnapshots,
  restoreSnapshot,
  pruneSnapshots,
  graphSlug,
  toFilenameTimestamp,
} from '../../src/lib/snapshot.js';
import type { OpenTologyConfig } from '../../src/lib/config.js';

const TMP = join(__dirname, '../../.test-tmp-snapshot');
const GRAPH_URI = 'https://opentology.dev/test-snap/context';

function makeConfig(mode: 'embedded' | 'http' = 'embedded'): OpenTologyConfig {
  return {
    projectId: 'test-snap',
    mode,
    graphUri: 'https://opentology.dev/test-snap',
    graphs: { context: GRAPH_URI },
  } as OpenTologyConfig;
}

describe('snapshot', () => {
  let originalCwd: string;

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    mkdirSync(join(TMP, '.opentology'), { recursive: true });
    writeFileSync(
      join(TMP, '.opentology.json'),
      JSON.stringify(makeConfig()),
      'utf-8',
    );
    originalCwd = process.cwd();
    process.chdir(TMP);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(TMP, { recursive: true, force: true });
  });

  describe('graphSlug', () => {
    it('converts graph URI to filesystem-safe slug', () => {
      const slug = graphSlug(GRAPH_URI);
      expect(slug).not.toContain('/');
      expect(slug).not.toContain(':');
      expect(slug.length).toBeGreaterThan(0);
    });
  });

  describe('toFilenameTimestamp', () => {
    it('generates ISO timestamp without colons', () => {
      const ts = toFilenameTimestamp(new Date('2026-04-05T14:30:22.123Z'));
      expect(ts).toBe('2026-04-05T14-30-22-123Z');
    });

    it('matches expected pattern', () => {
      const ts = toFilenameTimestamp();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });

  describe('snapshotGraph', () => {
    it('creates a .ttl file in .opentology/snapshots/', async () => {
      const adapter = new EmbeddedAdapter();
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:Alice ex:name "Alice" .
        ex:Bob ex:name "Bob" .
        ex:Carol ex:name "Carol" .
      `;
      adapter.loadTurtleIntoGraph(turtle, GRAPH_URI);

      const config = makeConfig();
      const result = await snapshotGraph(adapter, config, GRAPH_URI);

      expect(result).not.toBeNull();
      expect(existsSync(result!)).toBe(true);

      const content = readFileSync(result!, 'utf-8');
      expect(content).toContain('Alice');
      expect(content).toContain('Bob');
      expect(content).toContain('Carol');
    });

    it('skips snapshot for empty graph', async () => {
      const adapter = new EmbeddedAdapter();
      const config = makeConfig();
      const result = await snapshotGraph(adapter, config, GRAPH_URI);
      expect(result).toBeNull();
    });

    it('is a no-op for http mode', async () => {
      const adapter = new EmbeddedAdapter();
      adapter.loadTurtleIntoGraph(
        `@prefix ex: <http://example.org/> . ex:X ex:y "z" .`,
        GRAPH_URI,
      );
      const config = makeConfig('http');
      const result = await snapshotGraph(adapter, config, GRAPH_URI);
      expect(result).toBeNull();

      const snapshotDir = join(TMP, '.opentology', 'snapshots');
      expect(existsSync(snapshotDir)).toBe(false);
    });

    it('generates filename matching ISO timestamp pattern', async () => {
      const adapter = new EmbeddedAdapter();
      adapter.loadTurtleIntoGraph(
        `@prefix ex: <http://example.org/> . ex:X ex:y "z" .`,
        GRAPH_URI,
      );
      const config = makeConfig();
      const result = await snapshotGraph(adapter, config, GRAPH_URI);

      expect(result).not.toBeNull();
      const filename = result!.split('/').pop()!;
      expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.ttl$/);
    });
  });

  describe('listSnapshots', () => {
    it('returns empty array when no snapshots exist', () => {
      const result = listSnapshots(GRAPH_URI);
      expect(result).toEqual([]);
    });

    it('returns snapshots sorted by timestamp descending', async () => {
      const adapter = new EmbeddedAdapter();
      adapter.loadTurtleIntoGraph(
        `@prefix ex: <http://example.org/> . ex:X ex:y "z" .`,
        GRAPH_URI,
      );
      const config = makeConfig();

      // Create multiple snapshots with small delay
      await snapshotGraph(adapter, config, GRAPH_URI);
      await new Promise((r) => setTimeout(r, 10));
      await snapshotGraph(adapter, config, GRAPH_URI);

      const snapshots = listSnapshots(GRAPH_URI);
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      // First should be newest
      expect(snapshots[0]!.timestamp >= snapshots[1]!.timestamp).toBe(true);
      expect(snapshots[0]!.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('restoreSnapshot', () => {
    it('restores graph to snapshot state and creates pre-rollback', async () => {
      const adapter = new EmbeddedAdapter();
      const config = makeConfig();

      // Step 1: Insert original data and snapshot
      adapter.loadTurtleIntoGraph(
        `@prefix ex: <http://example.org/> . ex:Alice ex:name "Alice" .`,
        GRAPH_URI,
      );
      await snapshotGraph(adapter, config, GRAPH_URI);
      const snapshots = listSnapshots(GRAPH_URI);
      const snapshotTs = snapshots[0]!.timestamp;

      // Step 2: Modify graph (add Bob, drop Alice is not needed — just add)
      await adapter.dropGraph(GRAPH_URI);
      adapter.loadTurtleIntoGraph(
        `@prefix ex: <http://example.org/> . ex:Bob ex:name "Bob" .`,
        GRAPH_URI,
      );

      // Step 3: Restore
      await restoreSnapshot(adapter, config, GRAPH_URI, snapshotTs);

      // Verify Alice is back
      const result = await adapter.sparqlQuery(`
        SELECT ?name WHERE {
          GRAPH <${GRAPH_URI}> { ?s <http://example.org/name> ?name }
        }
      `);
      const names = result.results.bindings.map((b) => b['name']!.value);
      expect(names).toContain('Alice');
      expect(names).not.toContain('Bob');

      // Verify pre-rollback file exists
      const allSnapshots = listSnapshots(GRAPH_URI);
      const preRollback = allSnapshots.filter((s) => s.isPreRollback);
      expect(preRollback.length).toBe(1);
    });

    it('throws when snapshot not found', async () => {
      const adapter = new EmbeddedAdapter();
      const config = makeConfig();
      await expect(
        restoreSnapshot(adapter, config, GRAPH_URI, 'nonexistent'),
      ).rejects.toThrow('Snapshot not found');
    });
  });

  describe('pruneSnapshots', () => {
    it('keeps only the specified number of snapshots', async () => {
      const adapter = new EmbeddedAdapter();
      adapter.loadTurtleIntoGraph(
        `@prefix ex: <http://example.org/> . ex:X ex:y "z" .`,
        GRAPH_URI,
      );
      const config = makeConfig();

      // Create 4 snapshots
      for (let i = 0; i < 4; i++) {
        await snapshotGraph(adapter, config, GRAPH_URI, 100); // high retention so auto-prune doesn't kick in
        await new Promise((r) => setTimeout(r, 10));
      }

      let snapshots = listSnapshots(GRAPH_URI).filter((s) => !s.isPreRollback);
      expect(snapshots.length).toBe(4);

      // Prune to keep 2
      const deleted = await pruneSnapshots(GRAPH_URI, 2);
      expect(deleted).toBe(2);

      snapshots = listSnapshots(GRAPH_URI).filter((s) => !s.isPreRollback);
      expect(snapshots.length).toBe(2);
    });
  });
});
