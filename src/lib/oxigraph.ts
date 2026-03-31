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
