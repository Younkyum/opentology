import { describe, it, expect } from 'vitest';
import { EmbeddedAdapter } from '../../src/lib/embedded-adapter.js';
import { OTX_BOOTSTRAP_TURTLE } from '../../src/templates/otx-ontology.js';

const GRAPH_URI = 'https://opentology.dev/test-ontology/context';

describe('OTX_BOOTSTRAP_TURTLE', () => {
  it('parses without error', () => {
    const adapter = new EmbeddedAdapter();
    expect(() => {
      adapter.loadTurtleIntoGraph(OTX_BOOTSTRAP_TURTLE, GRAPH_URI);
    }).not.toThrow();
  });

  it('contains otx:Source class', async () => {
    const adapter = new EmbeddedAdapter();
    adapter.loadTurtleIntoGraph(OTX_BOOTSTRAP_TURTLE, GRAPH_URI);
    const result = await adapter.askQuery(`
      PREFIX otx: <https://opentology.dev/vocab#>
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      ASK WHERE {
        GRAPH <${GRAPH_URI}> { otx:Source a owl:Class }
      }
    `);
    expect(result).toBe(true);
  });

  it('contains otx:sourceUrl property', async () => {
    const adapter = new EmbeddedAdapter();
    adapter.loadTurtleIntoGraph(OTX_BOOTSTRAP_TURTLE, GRAPH_URI);
    const result = await adapter.askQuery(`
      PREFIX otx: <https://opentology.dev/vocab#>
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      ASK WHERE {
        GRAPH <${GRAPH_URI}> { otx:sourceUrl a owl:DatatypeProperty }
      }
    `);
    expect(result).toBe(true);
  });

  it('contains otx:sourceType property', async () => {
    const adapter = new EmbeddedAdapter();
    adapter.loadTurtleIntoGraph(OTX_BOOTSTRAP_TURTLE, GRAPH_URI);
    const result = await adapter.askQuery(`
      PREFIX otx: <https://opentology.dev/vocab#>
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      ASK WHERE {
        GRAPH <${GRAPH_URI}> { otx:sourceType a owl:DatatypeProperty }
      }
    `);
    expect(result).toBe(true);
  });
});
