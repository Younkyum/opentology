import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreAdapter } from './store-adapter.js';
import type { OpenTologyConfig } from './config.js';
import { persistGraph } from './persist.js';

const DEFAULT_RETENTION = 5;

/**
 * Derive a filesystem-safe slug from a graph URI.
 * Reuses the same pattern as persistGraph().
 */
export function graphSlug(graphUri: string): string {
  return graphUri.replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_');
}

/**
 * Generate an ISO timestamp suitable for filenames.
 * Format: 2026-04-05T14-30-22-123Z (colons replaced with dashes, ms included).
 */
export function toFilenameTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

/**
 * Parse a filename timestamp back to a Date.
 */
function parseFilenameTimestamp(filename: string): Date | null {
  // Remove .ttl suffix and _pre-rollback suffix
  const base = filename.replace(/\.ttl$/, '').replace(/_pre-rollback$/, '');
  // Reverse the filename encoding: dashes back to colons/dots
  // Format: 2026-04-05T14-30-22-123Z → 2026-04-05T14:30:22.123Z
  const parts = base.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/);
  if (!parts) return null;
  const iso = `${parts[1]}${parts[2]}:${parts[3]}:${parts[4]}.${parts[5]}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function snapshotDir(graphUri: string): string {
  return join(process.cwd(), '.opentology', 'snapshots', graphSlug(graphUri));
}

/**
 * Snapshot a named graph before a destructive operation.
 * No-op if not embedded mode or if the graph is empty.
 * Automatically prunes old snapshots after saving.
 */
export async function snapshotGraph(
  adapter: StoreAdapter,
  config: OpenTologyConfig,
  graphUri: string,
  retention: number = DEFAULT_RETENTION,
): Promise<string | null> {
  if (config.mode !== 'embedded') return null;

  const exported = await adapter.exportGraph(graphUri);
  if (!exported.trim()) return null;

  const dir = snapshotDir(graphUri);
  mkdirSync(dir, { recursive: true });

  const timestamp = toFilenameTimestamp();
  const filename = `${timestamp}.ttl`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, exported, 'utf-8');

  // Verify the file was written
  if (!existsSync(filePath)) {
    throw new Error(`Snapshot write failed: ${filePath}`);
  }

  // Prune old snapshots (create → verify → prune order)
  await pruneSnapshots(graphUri, retention);

  return filePath;
}

export interface SnapshotInfo {
  timestamp: string;
  path: string;
  sizeBytes: number;
  isPreRollback: boolean;
}

/**
 * List snapshots for a graph, sorted by timestamp descending (newest first).
 */
export function listSnapshots(graphUri: string): SnapshotInfo[] {
  const dir = snapshotDir(graphUri);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.ttl'));

  return files
    .map((f) => {
      const fullPath = join(dir, f);
      const stat = statSync(fullPath);
      return {
        timestamp: f.replace(/\.ttl$/, ''),
        path: fullPath,
        sizeBytes: stat.size,
        isPreRollback: f.includes('_pre-rollback'),
      };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Restore a graph to a specific snapshot.
 * 1. Saves current state as {timestamp}_pre-rollback.ttl (snapshot-before-rollback)
 * 2. Drops the graph and loads the snapshot
 * 3. Persists the restored state to .opentology/data/
 */
export async function restoreSnapshot(
  adapter: StoreAdapter,
  config: OpenTologyConfig,
  graphUri: string,
  timestamp: string,
): Promise<void> {
  const dir = snapshotDir(graphUri);
  const snapshotPath = join(dir, `${timestamp}.ttl`);

  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${timestamp}`);
  }

  // Step 1: Snapshot-before-rollback — save current state
  const currentExport = await adapter.exportGraph(graphUri);
  if (currentExport.trim()) {
    mkdirSync(dir, { recursive: true });
    const preRollbackTimestamp = toFilenameTimestamp();
    const preRollbackPath = join(dir, `${preRollbackTimestamp}_pre-rollback.ttl`);
    writeFileSync(preRollbackPath, currentExport, 'utf-8');
  }

  // Step 2: Drop and restore
  const snapshotTurtle = readFileSync(snapshotPath, 'utf-8');
  await adapter.dropGraph(graphUri);
  await adapter.insertTurtle(graphUri, snapshotTurtle);

  // Step 3: Persist restored state
  await persistGraph(adapter, config, graphUri);
}

/**
 * Prune old snapshots, keeping only the most recent `keep` count.
 * Pre-rollback snapshots are pruned separately (keep 2).
 */
export async function pruneSnapshots(
  graphUri: string,
  keep: number = DEFAULT_RETENTION,
): Promise<number> {
  const dir = snapshotDir(graphUri);
  if (!existsSync(dir)) return 0;

  const files = readdirSync(dir).filter((f) => f.endsWith('.ttl'));

  // Separate regular snapshots and pre-rollback snapshots
  const regular = files.filter((f) => !f.includes('_pre-rollback')).sort();
  const preRollback = files.filter((f) => f.includes('_pre-rollback')).sort();

  let deleted = 0;

  // Prune regular snapshots
  while (regular.length > keep) {
    const oldest = regular.shift()!;
    unlinkSync(join(dir, oldest));
    deleted++;
  }

  // Prune pre-rollback snapshots (keep max 2)
  while (preRollback.length > 2) {
    const oldest = preRollback.shift()!;
    unlinkSync(join(dir, oldest));
    deleted++;
  }

  return deleted;
}
