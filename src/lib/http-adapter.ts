import type { StoreAdapter, SparqlResults } from './store-adapter.js';
import {
  termToSparql,
  parseTurtle,
  extractPrefixes,
  serializeQuadsToTurtle,
} from './sparql-utils.js';

export class HttpAdapter implements StoreAdapter {
  constructor(private endpoint: string) {}

  async sparqlQuery(query: string): Promise<SparqlResults> {
    const url = `${this.endpoint}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: query,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `SPARQL query failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`,
      );
    }

    return response.json() as Promise<SparqlResults>;
  }

  async sparqlUpdate(update: string): Promise<void> {
    const url = `${this.endpoint}/update`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-update',
      },
      body: update,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `SPARQL update failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`,
      );
    }
  }

  async constructQuery(query: string): Promise<string> {
    const response = await fetch(`${this.endpoint}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'text/turtle',
      },
      body: query,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `SPARQL CONSTRUCT query failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`,
      );
    }

    return response.text();
  }

  async insertTurtle(graphUri: string, turtle: string): Promise<void> {
    const quads = await parseTurtle(turtle);

    if (quads.length === 0) {
      return;
    }

    const tripleLines = quads
      .map(
        (q) =>
          `  ${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)} .`,
      )
      .join('\n');

    const update = `INSERT DATA {\n  GRAPH <${graphUri}> {\n${tripleLines}\n  }\n}`;
    await this.sparqlUpdate(update);
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
    const query = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
    const turtleText = await this.constructQuery(query);

    // Re-serialize through n3 to ensure consistent formatting
    const quads = await parseTurtle(turtleText);
    return serializeQuadsToTurtle(quads);
  }

  async dropGraph(graphUri: string): Promise<void> {
    await this.sparqlUpdate(`DROP SILENT GRAPH <${graphUri}>`);
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
      await this.sparqlUpdate(update);
    } else if (options.where !== undefined) {
      const update = `DELETE { GRAPH <${graphUri}> { ?s ?p ?o } } WHERE { GRAPH <${graphUri}> { ?s ?p ?o . ${options.where} } }`;
      await this.sparqlUpdate(update);
    } else {
      throw new Error(
        'deleteTriples: either options.turtle or options.where must be provided',
      );
    }
  }

  async diffGraph(
    graphUri: string,
    localTurtle: string,
  ): Promise<{ added: string[]; removed: string[]; unchanged: number }> {
    const localQuads = await parseTurtle(localTurtle);
    const localSet = new Set(
      localQuads.map(
        (q) =>
          `${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)}`,
      ),
    );

    // Fetch remote quads via CONSTRUCT
    const query = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
    const remoteTurtle = await this.constructQuery(query);
    const remoteQuads = remoteTurtle.trim()
      ? await parseTurtle(remoteTurtle)
      : [];
    const remoteSet = new Set(
      remoteQuads.map(
        (q) =>
          `${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)}`,
      ),
    );

    const added = [...localSet].filter((t) => !remoteSet.has(t));
    const removed = [...remoteSet].filter((t) => !localSet.has(t));
    const unchanged = [...localSet].filter((t) => remoteSet.has(t)).length;

    return { added, removed, unchanged };
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
}
