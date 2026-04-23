import { loadConfig, saveConfig } from '../../lib/config.js';
import { createReadyAdapter } from '../../lib/store-factory.js';
import { snapshotGraph, listSnapshots, restoreSnapshot } from '../../lib/snapshot.js';
import { persistGraph } from '../../lib/persist.js';
import { getInferenceGraphUri } from '../../lib/sparql-utils.js';
import type { OpenTologyConfig } from '../../lib/config.js';

export async function handleStatus(args: Record<string, unknown>, resolveConfig: (params: { endpoint?: string; graphUri?: string; graph?: string }) => { config: OpenTologyConfig; graphUri: string }): Promise<unknown> {
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  const inferenceGraphUri = getInferenceGraphUri(graphUri);
  const assertedCount = await adapter.getGraphTripleCount(graphUri);
  const inferredCount = await adapter.getGraphTripleCount(inferenceGraphUri);
  return {
    projectId: config.projectId,
    mode: config.mode,
    endpoint: config.endpoint,
    graphUri,
    tripleCount: assertedCount + inferredCount,
    assertedCount,
    inferredCount,
  };
}

export async function handleGraphList(_args: Record<string, unknown>): Promise<unknown> {
  const config = loadConfig();
  const adapter = await createReadyAdapter(config);

  const results = await adapter.sparqlQuery(
    `SELECT DISTINCT ?g (COUNT(*) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g`
  );

  const baseUri = config.graphUri;
  const remoteGraphs = new Map<string, number>();
  for (const binding of results.results.bindings) {
    const g = binding['g']?.value;
    const count = binding['count']?.value;
    if (g && g.startsWith(baseUri)) {
      remoteGraphs.set(g, count ? parseInt(count, 10) : 0);
    }
  }

  const configGraphs = config.graphs ?? {};
  const uriToName = new Map<string, string>();
  uriToName.set(baseUri, '(default)');
  for (const [name, uri] of Object.entries(configGraphs)) {
    uriToName.set(uri, name);
  }

  const allUris = new Set<string>([
    baseUri,
    ...remoteGraphs.keys(),
    ...Object.values(configGraphs),
  ]);

  const graphList = [...allUris].map((uri) => ({
    name: uriToName.get(uri) ?? '?',
    uri,
    triples: remoteGraphs.get(uri) ?? null,
  }));

  return { graphs: graphList };
}

export async function handleGraphCreate(args: Record<string, unknown>): Promise<unknown> {
  const name = args.name as string;
  if (!name) {
    throw new Error('name is required');
  }

  const config = loadConfig();
  const graphs = config.graphs ?? {};
  if (graphs[name]) {
    throw new Error(`Graph '${name}' already exists: ${graphs[name]}`);
  }

  const uri = `${config.graphUri}/${name}`;
  graphs[name] = uri;
  config.graphs = graphs;
  saveConfig(config);

  return { success: true, name, uri };
}

export async function handleGraphDrop(args: Record<string, unknown>): Promise<unknown> {
  const name = args.name as string;
  const confirm = args.confirm as boolean;
  if (!name) {
    throw new Error('name is required');
  }
  if (!confirm) {
    throw new Error('Graph drop requires confirm: true to prevent accidental deletion.');
  }

  const config = loadConfig();
  const { resolveGraphUri } = await import('../../lib/config.js');
  const graphUri = resolveGraphUri(config, name);
  const adapter = await createReadyAdapter(config);

  await snapshotGraph(adapter, config, graphUri);
  await adapter.dropGraph(graphUri);
  await persistGraph(adapter, config, graphUri);

  const graphs = config.graphs ?? {};
  delete graphs[name];
  config.graphs = Object.keys(graphs).length > 0 ? graphs : undefined;
  saveConfig(config);

  return { success: true, name, graphUri };
}

export async function handleRollback(args: Record<string, unknown>, resolveConfig: (params: { endpoint?: string; graphUri?: string; graph?: string }) => { config: OpenTologyConfig; graphUri: string }): Promise<unknown> {
  const action = args.action as string;
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  if (action === 'list') {
    const snapshots = listSnapshots(graphUri);
    return { graphUri, snapshots };
  }

  if (action === 'restore') {
    const to = args.to as string;
    if (!to) {
      throw new Error('timestamp (to) is required for restore action');
    }
    const adapter = await createReadyAdapter(config);
    await restoreSnapshot(adapter, config, graphUri, to);
    return { success: true, graphUri, restoredTo: to };
  }

  throw new Error(`Unknown rollback action: ${action}. Use 'list' or 'restore'.`);
}

export async function handleDoctor(): Promise<unknown> {
  const { runDoctor } = await import('../../lib/doctor.js');
  return await runDoctor();
}

export async function handleAsk(args: Record<string, unknown>): Promise<unknown> {
  const { resolveGraphUri } = await import('../../lib/config.js');
  const config = loadConfig();
  const askGraphUri = args.graphUri as string
    || (args.graph ? resolveGraphUri(config, args.graph as string) : `${config.graphUri}/context`);
  const adapter = await createReadyAdapter(config);
  const { ask } = await import('../../lib/ask-engine.js');
  const result = await ask(adapter, askGraphUri, {
    predicate: args.predicate as string,
    context: (args.context as Record<string, string>) || {},
    record: args.record as boolean | undefined,
  });
  if ((result as { evaluationUri?: string }).evaluationUri) {
    await persistGraph(adapter, config, askGraphUri);
  }
  return result;
}
