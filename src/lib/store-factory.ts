import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreAdapter } from './store-adapter.js';
import type { OpenTologyConfig } from './config.js';
import { getTrackedFiles } from './config.js';
import { EmbeddedAdapter } from './embedded-adapter.js';
import { materializeInferences } from './reasoner.js';

// Singleton cache for embedded mode — keeps data alive across MCP tool calls.
let cachedAdapter: EmbeddedAdapter | null = null;
let loadedFileKeys = new Set<string>();

/**
 * Reset the cached embedded adapter. Useful for tests or after config-level
 * changes that invalidate the entire store (e.g. project re-init).
 */
export function resetAdapterCache(): void {
  cachedAdapter = null;
  loadedFileKeys = new Set();
}

export async function createReadyAdapter(config: OpenTologyConfig): Promise<StoreAdapter> {
  // Reuse cached adapter so data persists across MCP tool calls.
  if (!cachedAdapter) {
    cachedAdapter = new EmbeddedAdapter();
    loadedFileKeys = new Set();
  }

  const adapter = cachedAdapter;

  // Incrementally load only newly-tracked files into the existing store.
  const allGraphs = [config.graphUri, ...Object.keys(config.graphs ?? {}).map(k => config.graphs![k])];
  let newFilesLoaded = false;
  for (const graphUri of allGraphs) {
    const files = getTrackedFiles(config, graphUri);
    for (const f of files) {
      const key = `${graphUri}::${resolve(f)}`;
      if (!loadedFileKeys.has(key)) {
        try {
          const content = readFileSync(resolve(f), 'utf-8');
          adapter.loadTurtleIntoGraph(content, graphUri);
          loadedFileKeys.add(key);
          newFilesLoaded = true;
        } catch {
          // File may have been deleted — skip silently
        }
      }
    }
  }

  // Re-materialize inferences only when new file data was loaded.
  if (newFilesLoaded) {
    const allGraphUris = new Set<string>();
    allGraphUris.add(config.graphUri);
    if (config.graphs) {
      for (const uri of Object.values(config.graphs)) {
        allGraphUris.add(uri);
      }
    }
    for (const graphUri of allGraphUris) {
      const count = await adapter.getGraphTripleCount(graphUri);
      if (count > 0) {
        await materializeInferences(adapter, graphUri);
      }
    }
  }

  return adapter;
}
