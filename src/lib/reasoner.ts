import { Parser, Writer, DataFactory } from 'n3';
import { sparqlUpdate, insertTurtle, exportGraph } from './oxigraph.js';

const { namedNode } = DataFactory;

// ── Constants ──────────────────────────────────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUBPROPERTY_OF = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range';

/** URIs in the RDF/RDFS/OWL meta-vocabulary — skip meta-level reasoning. */
const META_NAMESPACES = [
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2002/07/owl#',
];

function isMeta(uri: string): boolean {
  return META_NAMESPACES.some((ns) => uri.startsWith(ns));
}

// ── Types ──────────────────────────────────────────────────────────────

interface Triple {
  s: string;
  p: string;
  o: string;
  isLiteral: boolean;
}

export interface InferenceResult {
  assertedCount: number;
  inferredCount: number;
  rules: Record<string, number>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function tripleKey(t: Triple): string {
  return `${t.s}\t${t.p}\t${t.o}\t${t.isLiteral}`;
}

/**
 * Compute the transitive closure of a binary relation expressed as triples
 * with a specific predicate. Returns all pairs (a, c) such that a R* c.
 */
function transitiveClosure(pairs: Array<[string, string]>): Array<[string, string]> {
  // Build adjacency map
  const children = new Map<string, Set<string>>();
  for (const [a, b] of pairs) {
    let set = children.get(a);
    if (!set) {
      set = new Set();
      children.set(a, set);
    }
    set.add(b);
  }

  const result: Array<[string, string]> = [];
  const visited = new Map<string, Set<string>>();

  function reachable(node: string): Set<string> {
    const cached = visited.get(node);
    if (cached) return cached;

    const reach = new Set<string>();
    visited.set(node, reach); // guard against cycles

    const direct = children.get(node);
    if (direct) {
      for (const child of direct) {
        reach.add(child);
        for (const grandchild of reachable(child)) {
          reach.add(grandchild);
        }
      }
    }
    return reach;
  }

  // Compute for every source node
  const allNodes = new Set<string>();
  for (const [a, b] of pairs) {
    allNodes.add(a);
    allNodes.add(b);
  }
  for (const node of allNodes) {
    for (const target of reachable(node)) {
      result.push([node, target]);
    }
  }

  return result;
}

// ── Pure inference engine ──────────────────────────────────────────────

export function computeInferences(triples: Triple[]): {
  inferred: Triple[];
  rules: Record<string, number>;
} {
  const assertedSet = new Set<string>(triples.map(tripleKey));
  const inferredMap = new Map<string, string>(); // tripleKey → rule name
  const rules: Record<string, number> = {};

  function addInferred(t: Triple, rule: string): void {
    const key = tripleKey(t);
    if (assertedSet.has(key) || inferredMap.has(key)) return;
    inferredMap.set(key, rule);
    rules[rule] = (rules[rule] ?? 0) + 1;
  }

  // ── Extract schema information ─────────────────────────────────────

  // Direct subClassOf pairs
  const subClassPairs: Array<[string, string]> = [];
  // Direct subPropertyOf pairs
  const subPropertyPairs: Array<[string, string]> = [];
  // Domain declarations: property → class
  const domainMap = new Map<string, string[]>();
  // Range declarations: property → class
  const rangeMap = new Map<string, string[]>();
  // Instance-of triples: subject → set of classes
  const instanceOf: Array<{ s: string; c: string }> = [];
  // All property-usage triples (non-rdf:type, non-schema predicates)
  const propertyUsages: Triple[] = [];

  for (const t of triples) {
    if (t.p === RDFS_SUBCLASS_OF && !t.isLiteral) {
      subClassPairs.push([t.s, t.o]);
    } else if (t.p === RDFS_SUBPROPERTY_OF && !t.isLiteral) {
      subPropertyPairs.push([t.s, t.o]);
    } else if (t.p === RDFS_DOMAIN && !t.isLiteral) {
      const existing = domainMap.get(t.s);
      if (existing) existing.push(t.o);
      else domainMap.set(t.s, [t.o]);
    } else if (t.p === RDFS_RANGE && !t.isLiteral) {
      const existing = rangeMap.get(t.s);
      if (existing) existing.push(t.o);
      else rangeMap.set(t.s, [t.o]);
    } else if (t.p === RDF_TYPE && !t.isLiteral) {
      instanceOf.push({ s: t.s, c: t.o });
    } else {
      propertyUsages.push(t);
    }
  }

  // ── rdfs11: subClassOf transitivity ────────────────────────────────

  const allSubClassPairs = transitiveClosure(subClassPairs);
  const subClassDirect = new Set(subClassPairs.map(([a, b]) => `${a}\t${b}`));

  for (const [a, c] of allSubClassPairs) {
    if (!subClassDirect.has(`${a}\t${c}`)) {
      addInferred(
        { s: a, p: RDFS_SUBCLASS_OF, o: c, isLiteral: false },
        'rdfs11',
      );
    }
  }

  // Build complete superclass map (including transitive)
  const superClasses = new Map<string, Set<string>>();
  for (const [sub, sup] of allSubClassPairs) {
    let set = superClasses.get(sub);
    if (!set) {
      set = new Set();
      superClasses.set(sub, set);
    }
    set.add(sup);
  }

  // ── subPropertyOf transitivity (feeds rdfs7) ──────────────────────

  const allSubPropertyPairs = transitiveClosure(subPropertyPairs);
  const subPropDirect = new Set(subPropertyPairs.map(([a, b]) => `${a}\t${b}`));

  for (const [a, c] of allSubPropertyPairs) {
    if (!subPropDirect.has(`${a}\t${c}`)) {
      addInferred(
        { s: a, p: RDFS_SUBPROPERTY_OF, o: c, isLiteral: false },
        'rdfs7', // transitive subPropertyOf is part of rdfs7 reasoning
      );
    }
  }

  // Build super-property map
  const superProperties = new Map<string, Set<string>>();
  for (const [sub, sup] of allSubPropertyPairs) {
    let set = superProperties.get(sub);
    if (!set) {
      set = new Set();
      superProperties.set(sub, set);
    }
    set.add(sup);
  }

  // ── rdfs9: subClassOf instance propagation ─────────────────────────

  for (const { s, c } of instanceOf) {
    if (isMeta(s)) continue;
    const supers = superClasses.get(c);
    if (!supers) continue;
    for (const superClass of supers) {
      addInferred(
        { s, p: RDF_TYPE, o: superClass, isLiteral: false },
        'rdfs9',
      );
    }
  }

  // ── rdfs7: subPropertyOf propagation ───────────────────────────────

  for (const t of propertyUsages) {
    if (isMeta(t.s)) continue;
    const supers = superProperties.get(t.p);
    if (!supers) continue;
    for (const superProp of supers) {
      addInferred(
        { s: t.s, p: superProp, o: t.o, isLiteral: t.isLiteral },
        'rdfs7',
      );
    }
  }

  // ── rdfs2: domain inference ────────────────────────────────────────

  for (const t of propertyUsages) {
    if (isMeta(t.s)) continue;
    const domains = domainMap.get(t.p);
    if (!domains) continue;
    for (const domainClass of domains) {
      addInferred(
        { s: t.s, p: RDF_TYPE, o: domainClass, isLiteral: false },
        'rdfs2',
      );
      // Also propagate superclasses of the domain class (rdfs9 follow-up)
      const supers = superClasses.get(domainClass);
      if (supers) {
        for (const superClass of supers) {
          addInferred(
            { s: t.s, p: RDF_TYPE, o: superClass, isLiteral: false },
            'rdfs9',
          );
        }
      }
    }
  }

  // ── rdfs3: range inference ─────────────────────────────────────────

  for (const t of propertyUsages) {
    if (t.isLiteral || isMeta(t.o)) continue;
    const ranges = rangeMap.get(t.p);
    if (!ranges) continue;
    for (const rangeClass of ranges) {
      addInferred(
        { s: t.o, p: RDF_TYPE, o: rangeClass, isLiteral: false },
        'rdfs3',
      );
      // Also propagate superclasses of the range class (rdfs9 follow-up)
      const supers = superClasses.get(rangeClass);
      if (supers) {
        for (const superClass of supers) {
          addInferred(
            { s: t.o, p: RDF_TYPE, o: superClass, isLiteral: false },
            'rdfs9',
          );
        }
      }
    }
  }

  // ── Collect results ────────────────────────────────────────────────

  const inferred: Triple[] = [];
  for (const [key] of inferredMap) {
    const parts = key.split('\t');
    inferred.push({
      s: parts[0]!,
      p: parts[1]!,
      o: parts[2]!,
      isLiteral: parts[3] === 'true',
    });
  }

  return { inferred, rules };
}

// ── Turtle serialization helpers ───────────────────────────────────────

function triplesToTurtle(triples: Triple[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: 'Turtle' });
    for (const t of triples) {
      const subject = namedNode(t.s);
      const predicate = namedNode(t.p);
      // All inferred triples from RDFS rules produce URIs (rdf:type, subClassOf, etc.)
      // Literals only appear in rdfs7 (subPropertyOf propagation), but those keep isLiteral flag.
      // For safety, we always produce NamedNode for object since our rules only infer URI objects.
      const object = namedNode(t.o);
      writer.addQuad(subject, predicate, object);
    }
    writer.end((err, result) => {
      if (err) reject(new Error(`Failed to serialize inferred triples: ${err.message}`));
      else resolve(result);
    });
  });
}

// ── Turtle parsing ─────────────────────────────────────────────────────

function parseTurtleToTriples(turtle: string): Promise<Triple[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser();
    const result: Triple[] = [];
    parser.parse(turtle, (err, quad) => {
      if (err) {
        reject(new Error(`Failed to parse Turtle: ${err.message}`));
        return;
      }
      if (quad) {
        result.push({
          s: quad.subject.value,
          p: quad.predicate.value,
          o: quad.object.value,
          isLiteral: quad.object.termType === 'Literal',
        });
      } else {
        resolve(result);
      }
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────

export function getInferenceGraphUri(graphUri: string): string {
  return `${graphUri}/inferred`;
}

export async function clearInferences(
  endpoint: string,
  graphUri: string,
): Promise<void> {
  const inferenceGraph = getInferenceGraphUri(graphUri);
  await sparqlUpdate(endpoint, `DROP SILENT GRAPH <${inferenceGraph}>`);
}

export async function materializeInferences(
  endpoint: string,
  graphUri: string,
): Promise<InferenceResult> {
  // 1. Fetch all triples from the asserted graph
  const turtle = await exportGraph(endpoint, graphUri);

  // 2. Parse into Triple[]
  const triples = turtle.trim() ? await parseTurtleToTriples(turtle) : [];

  // 3. Compute inferences (pure function)
  const { inferred, rules } = computeInferences(triples);

  // 4. Clear previous inference graph
  const inferenceGraph = getInferenceGraphUri(graphUri);
  await sparqlUpdate(endpoint, `DROP SILENT GRAPH <${inferenceGraph}>`);

  // 5. Insert inferred triples if any
  if (inferred.length > 0) {
    const inferredTurtle = await triplesToTurtle(inferred);
    await insertTurtle(endpoint, inferenceGraph, inferredTurtle);
  }

  // 6. Return result
  return {
    assertedCount: triples.length,
    inferredCount: inferred.length,
    rules,
  };
}
