import { Parser, Writer } from 'n3';
import type { Quad } from 'n3';


export interface SparqlResults {
  head: { vars: string[] };
  results: {
    bindings: Array<Record<string, { type: string; value: string; datatype?: string }>>;
  };
}

export async function sparqlQuery(
  endpoint: string,
  query: string
): Promise<SparqlResults> {
  const url = `${endpoint}/query`;
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
      `SPARQL query failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`
    );
  }

  return response.json() as Promise<SparqlResults>;
}

export async function sparqlUpdate(
  endpoint: string,
  update: string
): Promise<void> {
  const url = `${endpoint}/update`;
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
      `SPARQL update failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`
    );
  }
}

function termToSparql(term: Quad['subject'] | Quad['predicate'] | Quad['object']): string {
  switch (term.termType) {
    case 'NamedNode':
      return `<${term.value}>`;
    case 'BlankNode':
      return `_:${term.value}`;
    case 'Literal': {
      const escaped = term.value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      if (term.language) {
        return `"${escaped}"@${term.language}`;
      }
      if (term.datatype && term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
        return `"${escaped}"^^<${term.datatype.value}>`;
      }
      return `"${escaped}"`;
    }
    default:
      throw new Error(`Unsupported term type: ${(term as { termType: string }).termType}`);
  }
}

function parseTurtle(turtle: string): Promise<Quad[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser();
    const quads: Quad[] = [];
    parser.parse(turtle, (err, quad) => {
      if (err) {
        reject(new Error(`Failed to parse Turtle: ${err.message}`));
        return;
      }
      if (quad) {
        quads.push(quad);
      } else {
        resolve(quads);
      }
    });
  });
}

export async function insertTurtle(
  endpoint: string,
  graphUri: string,
  turtle: string
): Promise<void> {
  const quads = await parseTurtle(turtle);

  if (quads.length === 0) {
    return;
  }

  const tripleLines = quads
    .map((q) => `  ${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)} .`)
    .join('\n');

  const update = `INSERT DATA {\n  GRAPH <${graphUri}> {\n${tripleLines}\n  }\n}`;

  await sparqlUpdate(endpoint, update);
}

export async function getGraphTripleCount(
  endpoint: string,
  graphUri: string
): Promise<number> {
  const query = `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
  const results = await sparqlQuery(endpoint, query);

  const binding = results.results.bindings[0];
  if (!binding || !binding['count']) {
    return 0;
  }

  return parseInt(binding['count'].value, 10);
}

/**
 * Returns true if the query already manages its own graph scoping.
 * Matches GRAPH, FROM NAMED, or FROM < (case-insensitive).
 */
export function hasGraphScope(sparql: string): boolean {
  return /\bGRAPH\b|\bFROM\s+NAMED\b|\bFROM\s*</i.test(sparql);
}

/**
 * Wraps the WHERE body of a SPARQL SELECT/CONSTRUCT/ASK/DESCRIBE query so
 * that all triple patterns are scoped to `graphUri`.
 *
 * Handles:
 *   SELECT ... WHERE { ... }          → standard form
 *   SELECT ... { ... }               → shorthand (no WHERE keyword)
 *
 * Returns null if the outermost `{ ... }` block cannot be located safely.
 */
export function autoScopeQuery(sparql: string, graphUri: string): string | null {
  // Find the first `{` that opens the body.
  // We look for WHERE { or, as a fallback, any { after the projection clause.
  const whereMatch = sparql.match(/\bWHERE\s*\{/i);
  let braceStart: number;

  if (whereMatch && whereMatch.index !== undefined) {
    // Position of `{` inside `WHERE {`
    braceStart = whereMatch.index + whereMatch[0].length - 1;
  } else {
    // Shorthand: find the first `{`
    const firstBrace = sparql.indexOf('{');
    if (firstBrace === -1) return null;
    braceStart = firstBrace;
  }

  // Walk forward to find the matching closing `}` (respecting nesting).
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i++) {
    if (sparql[i] === '{') depth++;
    else if (sparql[i] === '}') {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }

  if (braceEnd === -1) return null;

  const before = sparql.slice(0, braceStart + 1);         // up to and including `{`
  const inner  = sparql.slice(braceStart + 1, braceEnd);  // content between `{ … }`
  const after  = sparql.slice(braceEnd);                   // from `}` onwards

  return `${before} GRAPH <${graphUri}> {${inner}} ${after}`;
}

const WELL_KNOWN_PREFIXES: Record<string, string> = {
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
  'http://www.w3.org/2000/01/rdf-schema#': 'rdfs',
  'http://www.w3.org/2002/07/owl#': 'owl',
  'http://schema.org/': 'schema',
  'http://xmlns.com/foaf/0.1/': 'foaf',
  'http://www.w3.org/2001/XMLSchema#': 'xsd',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'http://www.w3.org/2004/02/skos/core#': 'skos',
  'http://www.w3.org/ns/prov#': 'prov',
};

function extractPrefixes(uris: string[]): Record<string, string> {
  const prefixes: Record<string, string> = {};

  for (const uri of uris) {
    // Check well-known prefixes first
    for (const [ns, prefix] of Object.entries(WELL_KNOWN_PREFIXES)) {
      if (uri.startsWith(ns) && !(prefix in Object.values(prefixes))) {
        prefixes[prefix] = ns;
        break;
      }
    }

    // If not matched by well-known, derive from URI structure
    if (!Object.values(prefixes).some((ns) => uri.startsWith(ns))) {
      // Try hash-based namespace (e.g. http://example.org/ontology#)
      const hashIdx = uri.lastIndexOf('#');
      if (hashIdx !== -1) {
        const ns = uri.slice(0, hashIdx + 1);
        if (!Object.values(prefixes).includes(ns)) {
          // Derive a short prefix from the last path segment before the hash
          const pathSegments = ns.replace(/#$/, '').split('/').filter(Boolean);
          const candidate = pathSegments[pathSegments.length - 1]
            ?.toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .slice(0, 8);
          if (candidate && !(candidate in prefixes)) {
            prefixes[candidate] = ns;
          }
        }
      } else {
        // Slash-based namespace (e.g. http://example.org/ontology/)
        const slashIdx = uri.lastIndexOf('/');
        if (slashIdx !== -1) {
          const ns = uri.slice(0, slashIdx + 1);
          if (!Object.values(prefixes).includes(ns)) {
            const pathSegments = ns.replace(/\/$/, '').split('/').filter(Boolean);
            const candidate = pathSegments[pathSegments.length - 1]
              ?.toLowerCase()
              .replace(/[^a-z0-9]/g, '')
              .slice(0, 8);
            if (candidate && !(candidate in prefixes)) {
              prefixes[candidate] = ns;
            }
          }
        }
      }
    }
  }

  return prefixes;
}

export async function dropGraph(endpoint: string, graphUri: string): Promise<void> {
  await sparqlUpdate(endpoint, `DROP SILENT GRAPH <${graphUri}>`);
}

export async function deleteTriples(
  endpoint: string,
  graphUri: string,
  options: { turtle?: string; where?: string }
): Promise<void> {
  if (options.turtle !== undefined) {
    const quads = await parseTurtle(options.turtle);

    if (quads.length === 0) {
      return;
    }

    const tripleLines = quads
      .map((q) => `  ${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)} .`)
      .join('\n');

    const update = `DELETE DATA {\n  GRAPH <${graphUri}> {\n${tripleLines}\n  }\n}`;
    await sparqlUpdate(endpoint, update);
  } else if (options.where !== undefined) {
    const update = `DELETE { GRAPH <${graphUri}> { ?s ?p ?o } } WHERE { GRAPH <${graphUri}> { ?s ?p ?o . ${options.where} } }`;
    await sparqlUpdate(endpoint, update);
  } else {
    throw new Error('deleteTriples: either options.turtle or options.where must be provided');
  }
}

export async function getSchemaOverview(
  endpoint: string,
  graphUri: string
): Promise<{ prefixes: Record<string, string>; classes: string[]; properties: string[]; tripleCount: number }> {
  const tripleCount = await getGraphTripleCount(endpoint, graphUri);

  const classResults = await sparqlQuery(
    endpoint,
    `SELECT DISTINCT ?class WHERE { GRAPH <${graphUri}> { ?s a ?class } } ORDER BY ?class`
  );
  const classes = classResults.results.bindings
    .map((b) => b['class']?.value)
    .filter((v): v is string => v !== undefined);

  const propResults = await sparqlQuery(
    endpoint,
    `SELECT DISTINCT ?prop WHERE { GRAPH <${graphUri}> { ?s ?prop ?o } } ORDER BY ?prop`
  );
  const properties = propResults.results.bindings
    .map((b) => b['prop']?.value)
    .filter((v): v is string => v !== undefined);

  const prefixes = extractPrefixes([...classes, ...properties]);

  return { prefixes, classes, properties, tripleCount };
}

export async function getClassDetails(
  endpoint: string,
  graphUri: string,
  classUri: string
): Promise<{
  classUri: string;
  instanceCount: number;
  properties: Array<{ property: string; count: number }>;
  sampleTriples: Array<{ s: string; p: string; o: string }>;
}> {
  const countResults = await sparqlQuery(
    endpoint,
    `SELECT (COUNT(?s) as ?count) WHERE { GRAPH <${graphUri}> { ?s a <${classUri}> } }`
  );
  const countBinding = countResults.results.bindings[0];
  const instanceCount = countBinding?.['count']
    ? parseInt(countBinding['count'].value, 10)
    : 0;

  const propResults = await sparqlQuery(
    endpoint,
    `SELECT ?prop (COUNT(?prop) as ?count) WHERE { GRAPH <${graphUri}> { ?s a <${classUri}> . ?s ?prop ?o } } GROUP BY ?prop ORDER BY DESC(?count)`
  );
  const properties = propResults.results.bindings
    .filter((b) => b['prop'] && b['count'])
    .map((b) => ({
      property: b['prop']!.value,
      count: parseInt(b['count']!.value, 10),
    }));

  const sampleResults = await sparqlQuery(
    endpoint,
    `SELECT ?s ?p ?o WHERE { GRAPH <${graphUri}> { ?s a <${classUri}> . ?s ?p ?o } } LIMIT 5`
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

export async function diffGraph(
  endpoint: string,
  graphUri: string,
  localTurtle: string
): Promise<{ added: string[]; removed: string[]; unchanged: number }> {
  const localQuads = await parseTurtle(localTurtle);
  const localSet = new Set(
    localQuads.map((q) => `${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)}`)
  );

  // Fetch remote quads via CONSTRUCT
  const query = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
  const response = await fetch(`${endpoint}/query`, {
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
      `SPARQL CONSTRUCT query failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`
    );
  }

  const remoteTurtle = await response.text();
  const remoteQuads = remoteTurtle.trim() ? await parseTurtle(remoteTurtle) : [];
  const remoteSet = new Set(
    remoteQuads.map((q) => `${termToSparql(q.subject)} ${termToSparql(q.predicate)} ${termToSparql(q.object)}`)
  );

  const added = [...localSet].filter((t) => !remoteSet.has(t));
  const removed = [...remoteSet].filter((t) => !localSet.has(t));
  const unchanged = [...localSet].filter((t) => remoteSet.has(t)).length;

  return { added, removed, unchanged };
}

export async function exportGraph(
  endpoint: string,
  graphUri: string
): Promise<string> {
  const query = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;

  const response = await fetch(`${endpoint}/query`, {
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
      `SPARQL CONSTRUCT query failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`
    );
  }

  const turtleText = await response.text();

  // Re-serialize through n3.Writer to ensure consistent formatting
  const quads = await parseTurtle(turtleText);
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: 'Turtle' });
    writer.addQuads(quads);
    writer.end((err, result) => {
      if (err) {
        reject(new Error(`Failed to serialize Turtle: ${err.message}`));
      } else {
        resolve(result);
      }
    });
  });
}
