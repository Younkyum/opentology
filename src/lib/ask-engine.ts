import type { StoreAdapter } from './store-adapter.js';
import { autoScopeQuery } from './sparql-utils.js';

// ── Types ──

export interface AskInput {
  predicate: string;
  context: Record<string, string>;
  record?: boolean;
  graph?: string;
  graphUri?: string;
}

export interface AskOutput {
  answer: boolean | null;
  reason?: string;
  missing?: string[];
  evaluationUri?: string;
  bindings?: Array<Record<string, string>>;
}

interface ResolvedPredicate {
  uri: string;
  title: string;
  sparqlTemplate: string;
  requiredParams: string[];
}

// ── Resolve ──

export async function resolvePredicate(
  adapter: StoreAdapter,
  predicateName: string,
  contextGraphUri: string,
): Promise<ResolvedPredicate | null> {
  const sparql = `
    PREFIX otx: <https://opentology.dev/vocab#>
    SELECT ?uri ?title ?template ?param WHERE {
      GRAPH <${contextGraphUri}> {
        ?uri a otx:Predicate ;
             otx:title ?title ;
             otx:sparqlTemplate ?template .
        OPTIONAL { ?uri otx:requiredParam ?param }
        FILTER(?title = "${predicateName}" || ?uri = <urn:predicate:${predicateName}>)
      }
    }
  `;

  const results = await adapter.sparqlQuery(sparql);
  const bindings = results.results.bindings;
  if (bindings.length === 0) return null;

  const first = bindings[0];
  const requiredParams = bindings
    .map((b) => b.param?.value)
    .filter((v): v is string => !!v);

  return {
    uri: first.uri.value,
    title: first.title.value,
    sparqlTemplate: first.template.value,
    requiredParams: [...new Set(requiredParams)],
  };
}

// ── Validate ──

export function validateContext(
  predicate: ResolvedPredicate,
  context: Record<string, string>,
): string[] {
  return predicate.requiredParams.filter((p) => !(p in context));
}

// ── Evaluate ──

export function bindTemplate(
  template: string,
  context: Record<string, string>,
  graphUri: string,
): string {
  let bound = template;
  bound = bound.replace(/\{\{graphUri\}\}/g, graphUri);
  for (const [key, value] of Object.entries(context)) {
    bound = bound.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return bound;
}

export async function evaluate(
  adapter: StoreAdapter,
  sparql: string,
): Promise<{ answer: boolean; bindings?: Array<Record<string, string>> }> {
  const trimmed = sparql.trim();

  // ASK query → boolean
  if (/^(PREFIX\s+\S+:\s+<[^>]+>\s+)*ASK\b/i.test(trimmed)) {
    const answer = await adapter.askQuery(trimmed);
    return { answer };
  }

  // SELECT query → has results?
  const results = await adapter.sparqlQuery(trimmed);
  const bindings = results.results.bindings.map((b) => {
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      row[k] = v.value;
    }
    return row;
  });
  return { answer: bindings.length > 0, bindings: bindings.length > 0 ? bindings : undefined };
}

// ── Record ──

export async function recordEvaluation(
  adapter: StoreAdapter,
  graphUri: string,
  predicateUri: string,
  context: Record<string, string>,
  answer: boolean | null,
  sessionUri?: string,
): Promise<string> {
  const now = new Date().toISOString().slice(0, 10);
  const seq = Date.now() % 100000;
  const evalUri = `urn:evaluation:${now}-${seq}`;

  const inputJson = JSON.stringify(context).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let turtle = `
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${evalUri}> a otx:Evaluation ;
    otx:predicate <${predicateUri}> ;
    otx:input "${inputJson}" ;
    otx:result "${String(answer)}" ;
    otx:date "${now}"^^xsd:date .
`;

  if (sessionUri) {
    turtle += `<${evalUri}> otx:createdIn <${sessionUri}> .\n`;
  }

  await adapter.insertTurtle(graphUri, turtle);
  return evalUri;
}

// ── Main ask() ──

export async function ask(
  adapter: StoreAdapter,
  contextGraphUri: string,
  input: AskInput,
): Promise<AskOutput> {
  // 1. Resolve predicate
  const predicate = await resolvePredicate(adapter, input.predicate, contextGraphUri);
  if (!predicate) {
    return { answer: null, reason: `Unknown predicate: "${input.predicate}"` };
  }

  // 2. Validate required params
  const missing = validateContext(predicate, input.context);
  if (missing.length > 0) {
    return { answer: null, missing, reason: `Missing required parameters: ${missing.join(', ')}` };
  }

  // 3. Bind template and evaluate
  const boundSparql = bindTemplate(predicate.sparqlTemplate, input.context, contextGraphUri);
  const { answer, bindings } = await evaluate(adapter, boundSparql);

  // 4. Optionally record
  let evaluationUri: string | undefined;
  if (input.record !== false) {
    evaluationUri = await recordEvaluation(
      adapter,
      contextGraphUri,
      predicate.uri,
      input.context,
      answer,
    );
  }

  return {
    answer,
    reason: answer
      ? `Predicate "${predicate.title}" evaluated to true`
      : `Predicate "${predicate.title}" evaluated to false`,
    evaluationUri,
    bindings,
  };
}
