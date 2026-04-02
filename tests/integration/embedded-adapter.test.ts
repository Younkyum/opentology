import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddedAdapter } from '../../src/lib/embedded-adapter.js';

const GRAPH = 'https://test.org/graph';

describe('EmbeddedAdapter', () => {
  let adapter: EmbeddedAdapter;

  beforeEach(() => {
    adapter = new EmbeddedAdapter();
  });

  // ── 1. sparqlUpdate + sparqlQuery ─────────────────────────────────────

  describe('sparqlUpdate + sparqlQuery', () => {
    it('inserts data via SPARQL UPDATE and queries it back', async () => {
      await adapter.sparqlUpdate(`
        INSERT DATA {
          GRAPH <${GRAPH}> {
            <http://example.org/Alice> <http://example.org/name> "Alice" .
          }
        }
      `);

      const result = await adapter.sparqlQuery(`
        SELECT ?name WHERE {
          GRAPH <${GRAPH}> {
            <http://example.org/Alice> <http://example.org/name> ?name .
          }
        }
      `);

      expect(result.results.bindings).toHaveLength(1);
      expect(result.results.bindings[0]!['name']!.value).toBe('Alice');
      expect(result.results.bindings[0]!['name']!.type).toBe('literal');
    });
  });

  // ── 2. insertTurtle + sparqlQuery round-trip ──────────────────────────

  describe('insertTurtle + sparqlQuery round-trip', () => {
    it('inserts Turtle and queries it back', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:Bob ex:age "30" .
      `;

      await adapter.insertTurtle(GRAPH, turtle);

      const result = await adapter.sparqlQuery(`
        SELECT ?age WHERE {
          GRAPH <${GRAPH}> {
            <http://example.org/Bob> <http://example.org/age> ?age .
          }
        }
      `);

      expect(result.results.bindings).toHaveLength(1);
      expect(result.results.bindings[0]!['age']!.value).toBe('30');
    });
  });

  // ── 3. getGraphTripleCount ────────────────────────────────────────────

  describe('getGraphTripleCount', () => {
    it('returns 0 for an empty graph', async () => {
      const count = await adapter.getGraphTripleCount(GRAPH);
      expect(count).toBe(0);
    });

    it('returns correct count after inserts', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:A ex:p "1" .
        ex:B ex:p "2" .
        ex:C ex:p "3" .
      `;
      await adapter.insertTurtle(GRAPH, turtle);

      const count = await adapter.getGraphTripleCount(GRAPH);
      expect(count).toBe(3);
    });
  });

  // ── 4. exportGraph ────────────────────────────────────────────────────

  describe('exportGraph', () => {
    it('returns valid Turtle that can be re-parsed', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:X ex:rel ex:Y .
      `;
      await adapter.insertTurtle(GRAPH, turtle);

      const exported = await adapter.exportGraph(GRAPH);
      expect(exported).toBeTruthy();
      expect(exported).toContain('http://example.org/X');
      expect(exported).toContain('http://example.org/Y');

      // The exported Turtle can be loaded back into a fresh adapter
      const adapter2 = new EmbeddedAdapter();
      await adapter2.insertTurtle(GRAPH, exported);
      const count = await adapter2.getGraphTripleCount(GRAPH);
      expect(count).toBe(1);
    });
  });

  // ── 5. constructQuery ─────────────────────────────────────────────────

  describe('constructQuery', () => {
    it('returns Turtle with the correct triples', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:A ex:knows ex:B .
        ex:A ex:knows ex:C .
        ex:D ex:likes ex:E .
      `;
      await adapter.insertTurtle(GRAPH, turtle);

      const result = await adapter.constructQuery(`
        CONSTRUCT { ?s <http://example.org/knows> ?o }
        WHERE {
          GRAPH <${GRAPH}> { ?s <http://example.org/knows> ?o }
        }
      `);

      expect(result).toContain('http://example.org/A');
      expect(result).toContain('http://example.org/B');
      expect(result).toContain('http://example.org/C');
      // Should not contain the "likes" triple
      expect(result).not.toContain('http://example.org/likes');
    });
  });

  // ── 6. dropGraph ──────────────────────────────────────────────────────

  describe('dropGraph', () => {
    it('removes all triples, count goes to 0', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:A ex:p ex:B .
        ex:C ex:p ex:D .
      `;
      await adapter.insertTurtle(GRAPH, turtle);
      expect(await adapter.getGraphTripleCount(GRAPH)).toBe(2);

      await adapter.dropGraph(GRAPH);
      expect(await adapter.getGraphTripleCount(GRAPH)).toBe(0);
    });
  });

  // ── 7. deleteTriples (turtle mode) ────────────────────────────────────

  describe('deleteTriples (turtle mode)', () => {
    it('deletes specific triples via turtle, leaving others', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:A ex:p ex:B .
        ex:A ex:p ex:C .
        ex:A ex:p ex:D .
      `;
      await adapter.insertTurtle(GRAPH, turtle);
      expect(await adapter.getGraphTripleCount(GRAPH)).toBe(3);

      await adapter.deleteTriples(GRAPH, {
        turtle: `
          @prefix ex: <http://example.org/> .
          ex:A ex:p ex:B .
        `,
      });

      expect(await adapter.getGraphTripleCount(GRAPH)).toBe(2);

      // Verify the deleted triple is gone
      const result = await adapter.sparqlQuery(`
        SELECT ?o WHERE {
          GRAPH <${GRAPH}> { <http://example.org/A> <http://example.org/p> ?o }
        } ORDER BY ?o
      `);
      const values = result.results.bindings.map((b) => b['o']!.value);
      expect(values).toContain('http://example.org/C');
      expect(values).toContain('http://example.org/D');
      expect(values).not.toContain('http://example.org/B');
    });
  });

  // ── 8. deleteTriples (where mode) ─────────────────────────────────────

  describe('deleteTriples (where mode)', () => {
    it('deletes triples matching a WHERE pattern', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        ex:A rdf:type ex:Foo .
        ex:A ex:val "hello" .
        ex:B rdf:type ex:Bar .
        ex:B ex:val "world" .
      `;
      await adapter.insertTurtle(GRAPH, turtle);
      expect(await adapter.getGraphTripleCount(GRAPH)).toBe(4);

      // Delete all triples about ex:A
      await adapter.deleteTriples(GRAPH, {
        where: 'FILTER(?s = <http://example.org/A>)',
      });

      expect(await adapter.getGraphTripleCount(GRAPH)).toBe(2);

      // Verify only ex:B triples remain
      const result = await adapter.sparqlQuery(`
        SELECT ?s WHERE {
          GRAPH <${GRAPH}> { ?s ?p ?o }
        }
      `);
      const subjects = result.results.bindings.map((b) => b['s']!.value);
      expect(subjects.every((s) => s === 'http://example.org/B')).toBe(true);
    });
  });

  // ── 9. deleteTriples (no args) ────────────────────────────────────────

  describe('deleteTriples (no args)', () => {
    it('throws an error when neither turtle nor where is provided', async () => {
      await expect(
        adapter.deleteTriples(GRAPH, {}),
      ).rejects.toThrow('either options.turtle or options.where must be provided');
    });
  });

  // ── 10. diffGraph ─────────────────────────────────────────────────────

  describe('diffGraph', () => {
    it('detects added, removed, and unchanged triples', async () => {
      const original = `
        @prefix ex: <http://example.org/> .
        ex:A ex:p ex:B .
        ex:A ex:p ex:C .
      `;
      await adapter.insertTurtle(GRAPH, original);

      // Modified version: keeps ex:A ex:p ex:B, drops ex:A ex:p ex:C, adds ex:A ex:p ex:D
      const modified = `
        @prefix ex: <http://example.org/> .
        ex:A ex:p ex:B .
        ex:A ex:p ex:D .
      `;

      const diff = await adapter.diffGraph(GRAPH, modified);

      // "added" = in local but not in remote
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0]).toContain('http://example.org/D');

      // "removed" = in remote but not in local
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0]).toContain('http://example.org/C');

      // "unchanged" = present in both
      expect(diff.unchanged).toBe(1);
    });
  });

  // ── 11. getSchemaOverview ─────────────────────────────────────────────

  describe('getSchemaOverview', () => {
    it('returns classes, properties, prefixes, and tripleCount', async () => {
      const turtle = `
        @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        @prefix ex: <http://example.org/> .
        ex:Alice rdf:type ex:Person .
        ex:Alice ex:name "Alice" .
        ex:Bob rdf:type ex:Person .
        ex:Bob ex:age "30" .
      `;
      await adapter.insertTurtle(GRAPH, turtle);

      const overview = await adapter.getSchemaOverview(GRAPH);

      expect(overview.tripleCount).toBe(4);
      expect(overview.classes).toContain('http://example.org/Person');
      expect(overview.properties).toContain('http://example.org/name');
      expect(overview.properties).toContain('http://example.org/age');
      expect(overview.properties).toContain('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
      expect(Object.keys(overview.prefixes).length).toBeGreaterThan(0);
    });
  });

  // ── 12. getClassDetails ───────────────────────────────────────────────

  describe('getClassDetails', () => {
    it('returns instance count, properties, and sample triples', async () => {
      const turtle = `
        @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        @prefix ex: <http://example.org/> .
        ex:Alice rdf:type ex:Person .
        ex:Alice ex:name "Alice" .
        ex:Bob rdf:type ex:Person .
        ex:Bob ex:name "Bob" .
        ex:Bob ex:age "25" .
      `;
      await adapter.insertTurtle(GRAPH, turtle);

      const details = await adapter.getClassDetails(GRAPH, 'http://example.org/Person');

      expect(details.classUri).toBe('http://example.org/Person');
      expect(details.instanceCount).toBe(2);
      expect(details.properties.length).toBeGreaterThan(0);

      const propNames = details.properties.map((p) => p.property);
      expect(propNames).toContain('http://example.org/name');

      expect(details.sampleTriples.length).toBeGreaterThan(0);
      expect(details.sampleTriples.length).toBeLessThanOrEqual(5);
    });
  });

  // ── 13. Named graph isolation ─────────────────────────────────────────

  describe('named graph isolation', () => {
    const GRAPH_A = 'https://test.org/graphA';
    const GRAPH_B = 'https://test.org/graphB';

    it('data in graph A is not visible in graph B', async () => {
      const turtle = `
        @prefix ex: <http://example.org/> .
        ex:X ex:p ex:Y .
      `;
      await adapter.insertTurtle(GRAPH_A, turtle);

      const countA = await adapter.getGraphTripleCount(GRAPH_A);
      const countB = await adapter.getGraphTripleCount(GRAPH_B);

      expect(countA).toBe(1);
      expect(countB).toBe(0);

      // Query on graph B returns empty
      const result = await adapter.sparqlQuery(`
        SELECT ?s WHERE { GRAPH <${GRAPH_B}> { ?s ?p ?o } }
      `);
      expect(result.results.bindings).toHaveLength(0);
    });

    it('dropping graph A does not affect graph B', async () => {
      const turtleA = `
        @prefix ex: <http://example.org/> .
        ex:A1 ex:p ex:A2 .
      `;
      const turtleB = `
        @prefix ex: <http://example.org/> .
        ex:B1 ex:p ex:B2 .
      `;
      await adapter.insertTurtle(GRAPH_A, turtleA);
      await adapter.insertTurtle(GRAPH_B, turtleB);

      await adapter.dropGraph(GRAPH_A);

      expect(await adapter.getGraphTripleCount(GRAPH_A)).toBe(0);
      expect(await adapter.getGraphTripleCount(GRAPH_B)).toBe(1);
    });
  });
});
