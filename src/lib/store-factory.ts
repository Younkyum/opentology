import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreAdapter } from './store-adapter.js';
import type { OpenTologyConfig } from './config.js';
import { getTrackedFiles } from './config.js';
import { HttpAdapter } from './http-adapter.js';
import { EmbeddedAdapter } from './embedded-adapter.js';
import { materializeInferences } from './reasoner.js';

export function createAdapter(config: OpenTologyConfig): StoreAdapter {
  if (config.mode === 'embedded') {
    return new EmbeddedAdapter();
  }
  return new HttpAdapter(config.endpoint ?? 'http://localhost:7878');
}

export async function createReadyAdapter(config: OpenTologyConfig): Promise<StoreAdapter> {
  const adapter = createAdapter(config);

  if (config.mode === 'embedded' && adapter instanceof EmbeddedAdapter) {
    // Load all tracked files for all graphs
    const allGraphs = [config.graphUri, ...Object.keys(config.graphs ?? {}).map(k => config.graphs![k])];
    for (const graphUri of allGraphs) {
      const files = getTrackedFiles(config, graphUri);
      for (const f of files) {
        try {
          const content = readFileSync(resolve(f), 'utf-8');
          adapter.loadTurtleIntoGraph(content, graphUri);
        } catch {
          // File may have been deleted — skip silently
        }
      }
    }

    // Auto-run inference for embedded mode on every adapter creation.
    // The embedded store is ephemeral, so inferred triples must be re-materialized
    // each time a new adapter is constructed (e.g. on each CLI invocation).
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
