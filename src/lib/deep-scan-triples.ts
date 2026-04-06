/**
 * Converts DeepScanResult into OTX-compliant SPARQL INSERT DATA triples
 * with batched insert and scoped delete-then-insert strategy.
 */

import type { DeepScanResult } from './deep-scanner.js';
import { escapeTurtleLiteral } from './sparql-utils.js';

const OTX = 'https://opentology.dev/vocab#';

function encodeSegment(s: string): string {
  return encodeURIComponent(s);
}

function symbolUri(filePath: string, kind: string, name: string): string {
  return `urn:symbol:${encodeSegment(filePath)}/${encodeSegment(kind)}/${encodeSegment(name)}`;
}

function moduleUri(filePath: string): string {
  return `urn:module:${filePath}`;
}

const esc = escapeTurtleLiteral;

// ── Triple generation ───────────────────────────────────────────

export function generateSymbolTriples(result: DeepScanResult): string[] {
  const triples: string[] = [];

  for (const cls of result.classes) {
    const uri = symbolUri(cls.filePath, 'class', cls.name);
    triples.push(`<${uri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${OTX}Class> .`);
    triples.push(`<${uri}> <${OTX}title> "${esc(cls.name)}" .`);
    triples.push(`<${uri}> <${OTX}definedIn> <${moduleUri(cls.filePath)}> .`);

    if (cls.baseClass) {
      // baseClass is already a qualified path like "src/lib/foo/class/Bar"
      const parts = cls.baseClass.split('/');
      const baseName = parts.pop()!;
      const baseKind = parts.pop()!;
      const basePath = parts.join('/');
      const baseUri = symbolUri(basePath, baseKind, baseName);
      triples.push(`<${uri}> <${OTX}extends> <${baseUri}> .`);
    }

    for (const iface of cls.interfaces) {
      // interface is already qualified like "src/lib/foo/interface/Bar"
      const parts = iface.split('/');
      const ifaceName = parts.pop()!;
      const ifaceKind = parts.pop()!;
      const ifacePath = parts.join('/');
      const ifaceUri = symbolUri(ifacePath, ifaceKind, ifaceName);
      triples.push(`<${uri}> <${OTX}implements> <${ifaceUri}> .`);
    }

    for (const method of cls.methods) {
      const methodUri = symbolUri(cls.filePath, 'method', `${cls.name}.${method.name}`);
      triples.push(`<${methodUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${OTX}Method> .`);
      triples.push(`<${methodUri}> <${OTX}title> "${esc(method.name)}" .`);
      triples.push(`<${methodUri}> <${OTX}definedIn> <${moduleUri(cls.filePath)}> .`);
      triples.push(`<${uri}> <${OTX}hasMethod> <${methodUri}> .`);
      if (method.returnType && method.returnType !== 'void') {
        triples.push(`<${methodUri}> <${OTX}returns> "${esc(method.returnType)}" .`);
      }
      for (const p of method.parameters) {
        triples.push(`<${methodUri}> <${OTX}paramType> "${esc(p.name)}: ${esc(p.type)}" .`);
      }
    }
  }

  for (const iface of result.interfaces) {
    const uri = symbolUri(iface.filePath, 'interface', iface.name);
    triples.push(`<${uri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${OTX}Interface> .`);
    triples.push(`<${uri}> <${OTX}title> "${esc(iface.name)}" .`);
    triples.push(`<${uri}> <${OTX}definedIn> <${moduleUri(iface.filePath)}> .`);

    for (const ext of iface.extends) {
      // Interface extends are just names (not fully qualified) for now
      triples.push(`<${uri}> <${OTX}extends> "${esc(ext)}" .`);
    }
  }

  for (const fn of result.functions) {
    const uri = symbolUri(fn.filePath, 'function', fn.name);
    triples.push(`<${uri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${OTX}Function> .`);
    triples.push(`<${uri}> <${OTX}title> "${esc(fn.name)}" .`);
    triples.push(`<${uri}> <${OTX}definedIn> <${moduleUri(fn.filePath)}> .`);
    if (fn.returnType && fn.returnType !== 'void') {
      triples.push(`<${uri}> <${OTX}returns> "${esc(fn.returnType)}" .`);
    }
  }

  for (const call of result.methodCalls) {
    const callUri = `urn:call:${encodeSegment(call.caller)}--${encodeSegment(call.callee)}`;
    triples.push(`<${callUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${OTX}MethodCall> .`);
    triples.push(`<${callUri}> <${OTX}callerSymbol> "${esc(call.caller)}" .`);
    triples.push(`<${callUri}> <${OTX}calleeSymbol> "${esc(call.callee)}" .`);
    triples.push(`<${callUri}> <${OTX}title> "${esc(call.caller)} -> ${esc(call.callee)}" .`);
  }

  return triples;
}

// ── Batching ────────────────────────────────────────────────────

export function batchTriples(triples: string[], batchSize = 25): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < triples.length; i += batchSize) {
    batches.push(triples.slice(i, i + batchSize));
  }
  return batches;
}

// ── Scoped delete + batch insert ────────────────────────────────

import type { StoreAdapter as FullStoreAdapter } from './store-adapter.js';

type StoreAdapter = Pick<FullStoreAdapter, 'sparqlUpdate'>;

export async function deleteExistingSymbols(
  adapter: StoreAdapter,
  graphUri: string,
  modulePaths: string[],
): Promise<void> {
  for (const modPath of modulePaths) {
    const modUri = moduleUri(modPath);
    await adapter.sparqlUpdate(
      `DELETE WHERE { GRAPH <${graphUri}> { ?s <${OTX}definedIn> <${modUri}> . ?s ?p ?o } }`
    );
  }
  // Clean up MethodCall triples (no definedIn link, so delete all and re-insert)
  await adapter.sparqlUpdate(
    `DELETE WHERE { GRAPH <${graphUri}> { ?s a <${OTX}MethodCall> . ?s ?p ?o } }`
  );
}

export interface PushResult {
  triplesInserted: number;
  triplesFailed: number;
  batchCount: number;
  batchesFailed: number;
  errors: string[];
  retryHint: string | null;
}

export async function pushSymbolTriples(
  adapter: StoreAdapter,
  graphUri: string,
  result: DeepScanResult,
): Promise<PushResult> {
  // Collect all module paths for scoped delete
  const modulePaths = new Set<string>();
  for (const c of result.classes) modulePaths.add(c.filePath);
  for (const i of result.interfaces) modulePaths.add(i.filePath);
  for (const f of result.functions) modulePaths.add(f.filePath);

  // Delete existing symbols for these modules
  await deleteExistingSymbols(adapter, graphUri, [...modulePaths]);

  // Generate and batch-insert with per-batch error handling
  const triples = generateSymbolTriples(result);
  const batches = batchTriples(triples, 25);

  let inserted = 0;
  let failed = 0;
  let batchesFailed = 0;
  const errors: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      await adapter.sparqlUpdate(
        `INSERT DATA { GRAPH <${graphUri}> {\n${batch.join('\n')}\n} }`
      );
      inserted += batch.length;
    } catch (err) {
      batchesFailed++;
      failed += batch.length;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Batch ${i + 1}/${batches.length} failed (${batch.length} triples): ${msg}`);
    }
  }

  const retryHint = batchesFailed > 0
    ? `${batchesFailed}/${batches.length} batches failed (${failed} triples lost). Re-run context_scan with depth="symbol" to retry. If failures persist, try reducing maxSymbols or disabling includeMethodCalls.`
    : null;

  return { triplesInserted: inserted, triplesFailed: failed, batchCount: batches.length, batchesFailed, errors, retryHint };
}
