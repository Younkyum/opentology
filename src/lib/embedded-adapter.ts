import { DataFactory as N3DataFactory } from 'n3';
import type { Quad } from 'n3';
import oxigraph from 'oxigraph';
import type { StoreAdapter, SparqlResults } from './store-adapter.js';
import {
  termToSparql,
  parseTurtle,
  extractPrefixes,
  serializeQuadsToTurtle,
} from './sparql-utils.js';

/**
 * Convert an oxigraph WASM Term object to the SparqlResults binding format.
 */
function termToBinding(term: any): { type: string; value: string; datatype?: string } {
  switch (term.termType) {
    case 'NamedNode':
      return { type: 'uri', value: term.value };
    case 'BlankNode':
      return { type: 'bnode', value: term.value };
    case 'Literal': {
      const entry: { type: string; value: string; datatype?: string } = {
        type: 'literal',
        value: term.value,
      };
      if (term.datatype) {
        entry.datatype = term.datatype.value;
      }
      return entry;
    }
    default:
      return { type: 'uri', value: term.value };
  }
}

/**
 * Convert an oxigraph WASM Quad to an n3-compatible Quad for serialization.
 */
function wasmQuadToN3Quad(q: any): Quad {
  const subject =
    q.subject.termType === 'BlankNode'
      ? N3DataFactory.blankNode(q.subject.value)
      : N3DataFactory.namedNode(q.subject.value);

  const predicate = N3DataFactory.namedNode(q.predicate.value);

  let object;
  if (q.object.termType === 'Literal') {
    if (q.object.language) {
      object = N3DataFactory.literal(q.object.value, q.object.language);
    } else if (
      q.object.datatype &&
      q.object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string'
    ) {
      object = N3DataFactory.literal(
        q.object.value,
        N3DataFactory.namedNode(q.object.datatype.value),
      );
    } else {
      object = N3DataFactory.literal(q.object.value);
    }
  } else if (q.object.termType === 'BlankNode') {
    object = N3DataFactory.blankNode(q.object.value);
  } else {
    object = N3DataFactory.namedNode(q.object.value);
  }

  return N3DataFactory.quad(subject, predicate, object) as Quad;
}

export class EmbeddedAdapter implements StoreAdapter {
  private store: InstanceType<typeof oxigraph.Store>;

  constructor() {
    this.store = new oxigraph.Store();
  }

  /**
   * Load Turtle data directly into a named graph.
   */
  loadTurtleIntoGraph(turtle: string, graphUri: string): void {
    this.store.load(turtle, {
      format: 'text/turtle',
      base_iri: 'http://example.org/',
      to_graph_name: oxigraph.namedNode(graphUri),
    });
  }

  async askQuery(query: string): Promise<boolean> {
    const result = this.store.query(query);
    return result === true;
  }

  async sparqlQuery(query: string): Promise<SparqlResults> {
    const rawResults = this.store.query(query);

    // rawResults is an iterable of Map-like objects for SELECT queries
    const bindings: Array<Record<string, { type: string; value: string; datatype?: string }>> = [];
    const varsSet = new Set<string>();

    for (const row of rawResults) {
      const binding: Record<string, { type: string; value: string; datatype?: string }> = {};
      for (const [key, value] of row) {
        varsSet.add(key);
        if (value != null) {
          binding[key] = termToBinding(value);
        }
      }
      bindings.push(binding);
    }

    return {
      head: { vars: [...varsSet] },
      results: { bindings },
    };
  }

  async sparqlUpdate(update: string): Promise<void> {
    this.store.update(update);
  }

  async constructQuery(query: string): Promise<string> {
    const rawQuads = this.store.query(query);
    const n3Quads: Quad[] = [];
    for (const q of rawQuads) {
      n3Quads.push(wasmQuadToN3Quad(q));
    }
    return serializeQuadsToTurtle(n3Quads);
  }

  async insertTurtle(graphUri: string, turtle: string): Promise<void> {
    if (!turtle.trim()) {
      return;
    }
    this.loadTurtleIntoGraph(turtle, graphUri);
  }

  async getGraphTripleCount(graphUri: string): Promise<number> {
    const query = `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
    const results = await this.sparqlQuery(query);

    const binding = results.results.bindings[0];
    if (!binding || !binding['count']) {
      return 0;
    }

    return parseInt(binding['count'].value, 10);
  }

  async exportGraph(graphUri: string): Promise<string> {
    const quads = this.store.match(
      null,
      null,
      null,
      oxigraph.namedNode(graphUri),
    );
    const n3Quads: Quad[] = [];
    for (const q of quads) {
      n3Quads.push(wasmQuadToN3Quad(q));
    }
    return serializeQuadsToTurtle(n3Quads);
  }

  async dropGraph(graphUri: string): Promise<void> {
    this.store.update(`DROP SILENT GRAPH <${graphUri}>`);
  }

  async deleteTriples(
    graphUri: string,
    options: { turtle?: string; where?: string },
  ): Promise<void> {
    if (options.turtle !== undefined) {
      const quads = await parseTurtle(options.turtle);

      if (quads.length === 0) {
        return;
      }

      const tripleLines = quads
        .map(
          (q) =>
            `  ${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)} .`,
        )
        .join('\n');

      const update = `DELETE DATA {\n  GRAPH <${graphUri}> {\n${tripleLines}\n  }\n}`;
      this.store.update(update);
    } else if (options.where !== undefined) {
      const update = `DELETE { GRAPH <${graphUri}> { ?s ?p ?o } } WHERE { GRAPH <${graphUri}> { ?s ?p ?o . ${options.where} } }`;
      this.store.update(update);
    } else {
      throw new Error(
        'deleteTriples: either options.turtle or options.where must be provided',
      );
    }
  }

  async diffGraph(
    graphUri: string,
    localTurtle: string,
    limit = 50,
  ): Promise<{ added: string[]; removed: string[]; unchanged: number; addedCount: number; removedCount: number; truncated: boolean }> {
    const localQuads = await parseTurtle(localTurtle);
    const localSet = new Set(
      localQuads.map(
        (q) =>
          `${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)}`,
      ),
    );

    // Get remote quads from the store
    const remoteRawQuads = this.store.match(
      null,
      null,
      null,
      oxigraph.namedNode(graphUri),
    );
    const remoteSet = new Set<string>();
    for (const q of remoteRawQuads) {
      const n3q = wasmQuadToN3Quad(q);
      remoteSet.add(
        `${termToSparql(n3q.subject)} ${termToSparql(n3q.predicate)} ${termToSparql(n3q.object)}`,
      );
    }

    const allAdded = [...localSet].filter((t) => !remoteSet.has(t));
    const allRemoved = [...remoteSet].filter((t) => !localSet.has(t));
    const unchanged = [...localSet].filter((t) => remoteSet.has(t)).length;
    const truncated = allAdded.length > limit || allRemoved.length > limit;

    return {
      added: allAdded.slice(0, limit),
      removed: allRemoved.slice(0, limit),
      unchanged,
      addedCount: allAdded.length,
      removedCount: allRemoved.length,
      truncated,
    };
  }

  async getSchemaOverview(graphUri: string): Promise<{
    prefixes: Record<string, string>;
    classes: string[];
    properties: string[];
    tripleCount: number;
  }> {
    const tripleCount = await this.getGraphTripleCount(graphUri);

    const classResults = await this.sparqlQuery(
      `SELECT DISTINCT ?class WHERE { GRAPH <${graphUri}> { ?s a ?class } } ORDER BY ?class`,
    );
    const classes = classResults.results.bindings
      .map((b) => b['class']?.value)
      .filter((v): v is string => v !== undefined);

    const propResults = await this.sparqlQuery(
      `SELECT DISTINCT ?prop WHERE { GRAPH <${graphUri}> { ?s ?prop ?o } } ORDER BY ?prop`,
    );
    const properties = propResults.results.bindings
      .map((b) => b['prop']?.value)
      .filter((v): v is string => v !== undefined);

    const prefixes = extractPrefixes([...classes, ...properties]);

    return { prefixes, classes, properties, tripleCount };
  }

  async getClassDetails(
    graphUri: string,
    classUri: string,
  ): Promise<{
    classUri: string;
    instanceCount: number;
    properties: Array<{ property: string; count: number }>;
    sampleTriples: Array<{ s: string; p: string; o: string }>;
  }> {
    const countResults = await this.sparqlQuery(
      `SELECT (COUNT(?s) as ?count) WHERE { GRAPH <${graphUri}> { ?s a <${classUri}> } }`,
    );
    const countBinding = countResults.results.bindings[0];
    const instanceCount = countBinding?.['count']
      ? parseInt(countBinding['count'].value, 10)
      : 0;

    const propResults = await this.sparqlQuery(
      `SELECT ?prop (COUNT(?prop) as ?count) WHERE { GRAPH <${graphUri}> { ?s a <${classUri}> . ?s ?prop ?o } } GROUP BY ?prop ORDER BY DESC(?count)`,
    );
    const properties = propResults.results.bindings
      .filter((b) => b['prop'] && b['count'])
      .map((b) => ({
        property: b['prop']!.value,
        count: parseInt(b['count']!.value, 10),
      }));

    const sampleResults = await this.sparqlQuery(
      `SELECT ?s ?p ?o WHERE { GRAPH <${graphUri}> { ?s a <${classUri}> . ?s ?p ?o } } LIMIT 5`,
    );
    const sampleTriples = sampleResults.results.bindings
      .filter((b) => b['s'] && b['p'] && b['o'])
      .map((b) => ({
        s: b['s']!.value,
        p: b['p']!.value,
        o: b['o']!.value,
      }));

    return { classUri, instanceCount, properties, sampleTriples };
  }

  async getSchemaRelations(graphUri: string): Promise<import('./store-adapter.js').SchemaRelations> {
    const subClassResults = await this.sparqlQuery(
      `SELECT DISTINCT ?child ?parent WHERE { GRAPH <${graphUri}> { ?child <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?parent } }`,
    );
    const subClassOf = subClassResults.results.bindings
      .filter((b) => b['child'] && b['parent'])
      .map((b) => ({ child: b['child']!.value, parent: b['parent']!.value }));

    const domainRangeResults = await this.sparqlQuery(
      `SELECT DISTINCT ?prop ?domain ?range WHERE {
        GRAPH <${graphUri}> {
          ?prop a ?type .
          OPTIONAL { ?prop <http://www.w3.org/2000/01/rdf-schema#domain> ?domain }
          OPTIONAL { ?prop <http://www.w3.org/2000/01/rdf-schema#range> ?range }
          FILTER(?type IN (<http://www.w3.org/1999/02/22-rdf-syntax-ns#Property>, <http://www.w3.org/2002/07/owl#ObjectProperty>, <http://www.w3.org/2002/07/owl#DatatypeProperty>))
        }
      }`,
    );
    const domainRange = domainRangeResults.results.bindings
      .filter((b) => b['prop'] && (b['domain'] || b['range']))
      .map((b) => ({
        property: b['prop']!.value,
        domain: b['domain']?.value,
        range: b['range']?.value,
      }));

    return { subClassOf, domainRange };
  }
}
