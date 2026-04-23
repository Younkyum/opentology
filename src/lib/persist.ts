import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreAdapter } from './store-adapter.js';
import type { OpenTologyConfig } from './config.js';
import { addTrackedFile, saveConfig } from './config.js';

export const MAX_TRIPLES_PER_PUSH = 100;

export function assertTripleLimit(tripleCount: number): void {
  if (tripleCount > MAX_TRIPLES_PER_PUSH) {
    throw new Error(
      `Too many triples (${tripleCount}). Maximum is ${MAX_TRIPLES_PER_PUSH} per push. Split your data into smaller batches.`
    );
  }
}

/**
 * Persist a named graph to a .ttl file in embedded mode.
 * Exports the full graph, writes to .opentology/data/{slug}.ttl, and tracks
 * the file in config — mirroring CLI push behavior.
 */
export async function persistGraph(adapter: StoreAdapter, config: OpenTologyConfig, graphUri: string): Promise<void> {
  if (config.mode !== 'embedded') return;

  const exported = await adapter.exportGraph(graphUri);
  if (!exported.trim()) return;

  // Derive a filename slug from the graph URI
  const slug = graphUri.replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_');
  const dataDir = join(process.cwd(), '.opentology', 'data');
  const filePath = join(dataDir, `${slug}.ttl`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filePath, exported, 'utf-8');

  addTrackedFile(config, graphUri, filePath);
  saveConfig(config);
}
