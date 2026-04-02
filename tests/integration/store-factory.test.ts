import { describe, it, expect, beforeEach } from 'vitest';
import { createReadyAdapter, resetAdapterCache } from '../../src/lib/store-factory.js';
import type { OpenTologyConfig } from '../../src/lib/config.js';

const BASE_CONFIG: OpenTologyConfig = {
  projectId: 'test',
  mode: 'embedded',
  graphUri: 'https://test.org/graph',
  prefixes: {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    ex: 'http://example.org/',
  },
};

describe('createReadyAdapter — embedded singleton', () => {
  beforeEach(() => {
    resetAdapterCache();
  });

  it('returns the same adapter instance across calls', async () => {
    const a1 = await createReadyAdapter(BASE_CONFIG);
    const a2 = await createReadyAdapter(BASE_CONFIG);
    expect(a1).toBe(a2);
  });

  it('data pushed in one call is queryable in the next', async () => {
    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:Alice ex:name "Alice" .
    `;

    // Call 1: push data
    const adapter1 = await createReadyAdapter(BASE_CONFIG);
    await adapter1.insertTurtle(BASE_CONFIG.graphUri, turtle);

    // Call 2: query data (simulates a separate MCP tool call)
    const adapter2 = await createReadyAdapter(BASE_CONFIG);
    const result = await adapter2.sparqlQuery(`
      SELECT ?name WHERE {
        GRAPH <${BASE_CONFIG.graphUri}> {
          <http://example.org/Alice> <http://example.org/name> ?name .
        }
      }
    `);

    expect(result.results.bindings).toHaveLength(1);
    expect(result.results.bindings[0]!['name']!.value).toBe('Alice');
  });

  it('deletions persist across calls', async () => {
    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
      ex:A ex:p ex:C .
    `;

    const adapter1 = await createReadyAdapter(BASE_CONFIG);
    await adapter1.insertTurtle(BASE_CONFIG.graphUri, turtle);

    // Call 2: delete one triple
    const adapter2 = await createReadyAdapter(BASE_CONFIG);
    await adapter2.deleteTriples(BASE_CONFIG.graphUri, {
      turtle: `@prefix ex: <http://example.org/> .\nex:A ex:p ex:B .`,
    });

    // Call 3: verify deletion persisted
    const adapter3 = await createReadyAdapter(BASE_CONFIG);
    const count = await adapter3.getGraphTripleCount(BASE_CONFIG.graphUri);
    expect(count).toBe(1);
  });

  it('dropGraph persists across calls', async () => {
    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:X ex:p ex:Y .
    `;

    const adapter1 = await createReadyAdapter(BASE_CONFIG);
    await adapter1.insertTurtle(BASE_CONFIG.graphUri, turtle);
    expect(await adapter1.getGraphTripleCount(BASE_CONFIG.graphUri)).toBe(1);

    // Call 2: drop
    const adapter2 = await createReadyAdapter(BASE_CONFIG);
    await adapter2.dropGraph(BASE_CONFIG.graphUri);

    // Call 3: verify empty
    const adapter3 = await createReadyAdapter(BASE_CONFIG);
    expect(await adapter3.getGraphTripleCount(BASE_CONFIG.graphUri)).toBe(0);
  });

  it('resetAdapterCache creates a fresh store', async () => {
    const adapter1 = await createReadyAdapter(BASE_CONFIG);
    await adapter1.insertTurtle(BASE_CONFIG.graphUri, `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
    `);

    resetAdapterCache();

    const adapter2 = await createReadyAdapter(BASE_CONFIG);
    expect(adapter2).not.toBe(adapter1);
    expect(await adapter2.getGraphTripleCount(BASE_CONFIG.graphUri)).toBe(0);
  });
});
