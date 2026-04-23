import { loadConfig, saveConfig, configExists, resolveGraphUri } from '../../lib/config.js';
import type { OpenTologyConfig } from '../../lib/config.js';
import { createReadyAdapter } from '../../lib/store-factory.js';
import { snapshotGraph } from '../../lib/snapshot.js';
import { hasGraphScope, autoScopeQuery } from '../../lib/sparql-utils.js';
import { persistGraph, assertTripleLimit } from '../../lib/persist.js';
import { validateTurtle } from '../../lib/validator.js';
import { discoverShapes, validateWithShacl, hasShapes } from '../../lib/shacl.js';
import { materializeInferences } from '../../lib/reasoner.js';
import type { InferenceResult } from '../../lib/reasoner.js';

export function resolveConfig(params: { endpoint?: string; graphUri?: string; graph?: string }): { config: OpenTologyConfig; graphUri: string } {
  try {
    const config = loadConfig();
    let graphUri = params.graphUri || config.graphUri;
    if (params.graph) {
      graphUri = resolveGraphUri(config, params.graph);
    }
    return { config, graphUri };
  } catch {
    throw new Error('No config found. Run opentology init first.');
  }
}

export async function handleInit(args: Record<string, unknown>): Promise<unknown> {
  const projectId = args.projectId as string;
  const mode = (args.mode as 'http' | 'embedded') || 'http';
  const endpoint = mode === 'http' ? ((args.endpoint as string) || 'http://localhost:7878') : undefined;

  if (configExists()) {
    throw new Error('Project already initialized. .opentology.json exists in the current directory.');
  }

  const graphUri = `https://opentology.dev/${projectId}`;
  const prefixes: Record<string, string> = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    schema: 'http://schema.org/',
  };
  const config: OpenTologyConfig = { projectId, mode, graphUri, prefixes, ...(endpoint ? { endpoint } : {}) };
  saveConfig(config);

  return { projectId, mode, endpoint, graphUri };
}

export async function handleValidate(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string;
  const shacl = args.shacl as boolean | undefined;
  const result = await validateTurtle(content);

  if (shacl && result.valid) {
    const shapePaths = discoverShapes();
    if (shapePaths.length > 0) {
      const report = await validateWithShacl(content, shapePaths);
      return { ...result, shacl: report };
    }
    return { ...result, shacl: { conforms: true, violations: [], note: 'no shapes found' } };
  }

  return result;
}

export async function handlePush(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string;
  const replace = args.replace as boolean | undefined;
  const shacl = args.shacl as boolean | undefined;
  const validation = await validateTurtle(content);
  if (!validation.valid) {
    throw new Error(`Invalid Turtle: ${validation.error}`);
  }

  assertTripleLimit(validation.tripleCount!);

  // Auto-validate against SHACL when shapes exist (unless explicitly false)
  if (shacl !== false && hasShapes()) {
    const shapePaths = discoverShapes();
    const report = await validateWithShacl(content, shapePaths);
    if (!report.conforms) {
      const violationMessages = report.violations
        .map((v) => `SHACL Violation: ${v.focusNode} — ${v.message} (path: ${v.path})`)
        .join('\n');
      throw new Error(`SHACL validation failed:\n${violationMessages}`);
    }
  }

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);

  if (replace) {
    await snapshotGraph(adapter, config, graphUri);
    await adapter.dropGraph(graphUri);
  }

  await adapter.insertTurtle(graphUri, content);

  const infer = args.infer as boolean | undefined;
  let inference: InferenceResult | undefined;
  if (infer !== false) {
    inference = await materializeInferences(adapter, graphUri);
  }

  await persistGraph(adapter, config, graphUri);

  return {
    success: true,
    tripleCount: validation.tripleCount,
    replaced: !!replace,
    ...(inference ? { inferredCount: inference.inferredCount, inferenceRules: inference.rules } : {}),
  };
}

export function injectPrefixes(sparql: string, prefixes: Record<string, string>): string {
  const lines = Object.entries(prefixes)
    .filter(([prefix]) => {
      const re = new RegExp(`PREFIX\\s+${prefix}\\s*:`, 'i');
      return !re.test(sparql);
    })
    .map(([prefix, uri]) => `PREFIX ${prefix}: <${uri}>`);
  if (lines.length === 0) return sparql;
  return lines.join('\n') + '\n' + sparql;
}

export async function handleQuery(args: Record<string, unknown>): Promise<unknown> {
  const sparql = args.sparql as string;
  const raw = args.raw as boolean | undefined;

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  let query = sparql;

  // Inject project-level PREFIX declarations from config
  if (config.prefixes) {
    query = injectPrefixes(query, config.prefixes);
  }

  if (!raw && !hasGraphScope(sparql)) {
    const scoped = autoScopeQuery(sparql, graphUri);
    if (scoped) {
      query = scoped;
    }
  }

  const adapter = await createReadyAdapter(config);
  return await adapter.sparqlQuery(query);
}

export async function handlePull(args: Record<string, unknown>): Promise<unknown> {
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  const turtle = await adapter.exportGraph(graphUri);
  return turtle;
}

export async function handleDrop(args: Record<string, unknown>): Promise<unknown> {
  const confirm = args.confirm as boolean;
  if (!confirm) {
    throw new Error('Drop requires confirm: true to prevent accidental deletion.');
  }

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  await snapshotGraph(adapter, config, graphUri);
  await adapter.dropGraph(graphUri);
  await persistGraph(adapter, config, graphUri);
  return { success: true, graphUri };
}

export async function handleDelete(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string | undefined;
  const where = args.where as string | undefined;

  if (!content && !where) {
    throw new Error('Provide either content (Turtle) or where (SPARQL pattern)');
  }

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  await snapshotGraph(adapter, config, graphUri);
  await adapter.deleteTriples(graphUri, { turtle: content, where });
  await persistGraph(adapter, config, graphUri);
  return { success: true };
}

export async function handleDiff(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string;
  if (!content) {
    throw new Error('content (Turtle) is required');
  }

  const limit = typeof args.limit === 'number' ? args.limit : 50;

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  return await adapter.diffGraph(graphUri, content, limit);
}
