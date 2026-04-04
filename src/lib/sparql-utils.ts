import { Parser, Writer } from 'n3';
import type { Quad } from 'n3';

// ── Well-known prefixes ───────────────────────────────────────────────

export const WELL_KNOWN_PREFIXES: Record<string, string> = {
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

// ── Term / Turtle helpers ─────────────────────────────────────────────

export function termToSparql(term: Quad['subject'] | Quad['predicate'] | Quad['object']): string {
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

export function parseTurtle(turtle: string): Promise<Quad[]> {
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

export function serializeQuadsToTurtle(quads: Quad[]): Promise<string> {
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

// ── Prefix extraction ─────────────────────────────────────────────────

export function extractPrefixes(uris: string[]): Record<string, string> {
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

// ── Query scoping ─────────────────────────────────────────────────────

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
 *   SELECT ... WHERE { ... }          -> standard form
 *   SELECT ... { ... }               -> shorthand (no WHERE keyword)
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

  const before = sparql.slice(0, braceStart + 1); // up to and including `{`
  const inner = sparql.slice(braceStart + 1, braceEnd); // content between `{ ... }`
  const after = sparql.slice(braceEnd); // from `}` onwards

  return `${before} GRAPH <${graphUri}> {${inner}} ${after}`;
}

// ── Inference graph URI ───────────────────────────────────────────────

export function getInferenceGraphUri(graphUri: string): string {
  return `${graphUri}/inferred`;
}
