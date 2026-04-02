import { describe, it, expect } from 'vitest';
import { EmbeddedAdapter } from '../../src/lib/embedded-adapter.js';
import { materializeInferences, clearInferences } from '../../src/lib/reasoner.js';

const GRAPH = 'https://test.org/workflow';

describe('Workflow: push -> infer -> query cycle', () => {
  it('materializes rdfs:subClassOf inferences and queries superclass instances', async () => {
    const adapter = new EmbeddedAdapter();

    const ontology = `
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix ex: <http://example.org/> .
      ex:Person rdf:type rdfs:Class .
      ex:Doctor rdfs:subClassOf ex:Person .
      ex:Kim rdf:type ex:Doctor .
      ex:Kim ex:name "Dr. Kim" .
    `;
    await adapter.insertTurtle(GRAPH, ontology);

    // Before inference: Kim is only a Doctor
    const beforeResult = await adapter.sparqlQuery(`
      SELECT ?s WHERE {
        GRAPH <${GRAPH}> { ?s a <http://example.org/Person> }
      }
    `);
    expect(beforeResult.results.bindings).toHaveLength(0);

    // Materialize inferences
    const result = await materializeInferences(adapter, GRAPH);
    expect(result.inferredCount).toBeGreaterThan(0);
    expect(result.rules).toHaveProperty('rdfs9');

    // After inference: Kim is also a Person via rdfs9
    const afterResult = await adapter.sparqlQuery(`
      SELECT ?s WHERE {
        GRAPH <${GRAPH}> { ?s a <http://example.org/Person> }
      }
    `);
    expect(afterResult.results.bindings).toHaveLength(1);
    expect(afterResult.results.bindings[0]!['s']!.value).toBe('http://example.org/Kim');
  });

  it('clearInferences removes inferred triples', async () => {
    const adapter = new EmbeddedAdapter();

    const ontology = `
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix ex: <http://example.org/> .
      ex:Doctor rdfs:subClassOf ex:Person .
      ex:Kim rdf:type ex:Doctor .
    `;
    await adapter.insertTurtle(GRAPH, ontology);
    await materializeInferences(adapter, GRAPH);

    // Kim is a Person after inference
    let result = await adapter.sparqlQuery(`
      SELECT ?s WHERE {
        GRAPH <${GRAPH}> { ?s a <http://example.org/Person> }
      }
    `);
    expect(result.results.bindings).toHaveLength(1);

    // Clear inferences
    await clearInferences(adapter, GRAPH);

    // Kim is no longer a Person
    result = await adapter.sparqlQuery(`
      SELECT ?s WHERE {
        GRAPH <${GRAPH}> { ?s a <http://example.org/Person> }
      }
    `);
    expect(result.results.bindings).toHaveLength(0);
  });
});

describe('Workflow: push --replace behavior', () => {
  it('drop + re-insert replaces graph contents entirely', async () => {
    const adapter = new EmbeddedAdapter();

    const v1 = `
      @prefix ex: <http://example.org/> .
      ex:A ex:version "1" .
      ex:A ex:old "data" .
    `;
    await adapter.insertTurtle(GRAPH, v1);
    expect(await adapter.getGraphTripleCount(GRAPH)).toBe(2);

    // Replace: drop then insert V2
    await adapter.dropGraph(GRAPH);

    const v2 = `
      @prefix ex: <http://example.org/> .
      ex:B ex:version "2" .
    `;
    await adapter.insertTurtle(GRAPH, v2);

    expect(await adapter.getGraphTripleCount(GRAPH)).toBe(1);

    // Only V2 data present
    const result = await adapter.sparqlQuery(`
      SELECT ?s ?p ?o WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }
    `);
    expect(result.results.bindings).toHaveLength(1);
    expect(result.results.bindings[0]!['s']!.value).toBe('http://example.org/B');
    expect(result.results.bindings[0]!['o']!.value).toBe('2');

    // V1 data gone
    const v1Result = await adapter.sparqlQuery(`
      SELECT ?o WHERE {
        GRAPH <${GRAPH}> { <http://example.org/A> ?p ?o }
      }
    `);
    expect(v1Result.results.bindings).toHaveLength(0);
  });
});

describe('Workflow: diffGraph scenarios', () => {
  it('diff with superset file shows added triples', async () => {
    const adapter = new EmbeddedAdapter();

    const subset = `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
    `;
    await adapter.insertTurtle(GRAPH, subset);

    const superset = `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
      ex:A ex:p ex:C .
      ex:A ex:p ex:D .
    `;

    const diff = await adapter.diffGraph(GRAPH, superset);

    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
  });

  it('diff with subset file shows removed triples', async () => {
    const adapter = new EmbeddedAdapter();

    const superset = `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
      ex:A ex:p ex:C .
      ex:A ex:p ex:D .
    `;
    await adapter.insertTurtle(GRAPH, superset);

    const subset = `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
    `;

    const diff = await adapter.diffGraph(GRAPH, subset);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(2);
    expect(diff.unchanged).toBe(1);
  });

  it('diff with identical data shows no changes', async () => {
    const adapter = new EmbeddedAdapter();

    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:A ex:p ex:B .
      ex:C ex:p ex:D .
      ex:E ex:p ex:F .
    `;
    await adapter.insertTurtle(GRAPH, turtle);

    const diff = await adapter.diffGraph(GRAPH, turtle);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(3);
  });
});

describe('Workflow: getSchemaOverview full', () => {
  it('returns complete schema information for rich data', async () => {
    const adapter = new EmbeddedAdapter();

    const turtle = `
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix ex: <http://example.org/> .

      ex:Person rdf:type rdfs:Class .
      ex:Organization rdf:type rdfs:Class .

      ex:Alice rdf:type ex:Person .
      ex:Alice ex:name "Alice" .
      ex:Alice ex:age "30" .
      ex:Alice ex:worksAt ex:Acme .

      ex:Bob rdf:type ex:Person .
      ex:Bob ex:name "Bob" .

      ex:Acme rdf:type ex:Organization .
      ex:Acme ex:name "Acme Corp" .
    `;
    await adapter.insertTurtle(GRAPH, turtle);

    const overview = await adapter.getSchemaOverview(GRAPH);

    // Triple count: 2 Class declarations + 3 Alice triples + 1 Alice type +
    //               1 Bob name + 1 Bob type + 1 Acme name + 1 Acme type = 10
    expect(overview.tripleCount).toBe(10);

    // Classes used in rdf:type assertions
    expect(overview.classes).toContain('http://example.org/Person');
    expect(overview.classes).toContain('http://example.org/Organization');
    expect(overview.classes).toContain('http://www.w3.org/2000/01/rdf-schema#Class');

    // Properties
    expect(overview.properties).toContain('http://example.org/name');
    expect(overview.properties).toContain('http://example.org/age');
    expect(overview.properties).toContain('http://example.org/worksAt');
    expect(overview.properties).toContain('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

    // Prefixes should be extracted from URIs
    expect(Object.keys(overview.prefixes).length).toBeGreaterThan(0);
  });
});
