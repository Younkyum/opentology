import { createReadyAdapter } from '../../lib/store-factory.js';
import { fromSchemaData, toMermaid, toDot } from '../../lib/visualizer.js';
import { materializeInferences, clearInferences } from '../../lib/reasoner.js';
import { persistGraph } from '../../lib/persist.js';
import { snapshotGraph } from '../../lib/snapshot.js';
import type { InferenceResult } from '../../lib/reasoner.js';
import type { OpenTologyConfig } from '../../lib/config.js';

export async function handleSchema(args: Record<string, unknown>, resolveConfig: (params: { endpoint?: string; graphUri?: string; graph?: string }) => { config: OpenTologyConfig; graphUri: string }): Promise<unknown> {
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  const classUri = args.class as string | undefined;

  if (classUri) {
    return await adapter.getClassDetails(graphUri, classUri);
  } else {
    return await adapter.getSchemaOverview(graphUri);
  }
}

export async function handleVisualize(args: Record<string, unknown>, resolveConfig: (params: { endpoint?: string; graphUri?: string; graph?: string }) => { config: OpenTologyConfig; graphUri: string }): Promise<unknown> {
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const target = (args.target as string) || 'schema';
  if (target !== 'schema') {
    throw new Error(`Unsupported target "${target}". Currently only "schema" is supported.`);
  }

  const format = (args.format as string) || 'mermaid';
  if (format !== 'mermaid' && format !== 'dot') {
    throw new Error(`Unsupported format "${format}". Use "mermaid" or "dot".`);
  }

  const adapter = await createReadyAdapter(config);
  const overview = await adapter.getSchemaOverview(graphUri);
  const relations = await adapter.getSchemaRelations(graphUri);
  const visGraph = fromSchemaData(overview, relations);

  return format === 'dot' ? toDot(visGraph) : toMermaid(visGraph);
}

export async function handleInfer(args: Record<string, unknown>, resolveConfig: (params: { endpoint?: string; graphUri?: string; graph?: string }) => { config: OpenTologyConfig; graphUri: string }): Promise<unknown> {
  const clear = args.clear as boolean | undefined;
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);

  if (clear) {
    await snapshotGraph(adapter, config, graphUri);
    await clearInferences(adapter, graphUri);
    await persistGraph(adapter, config, graphUri);
    return { success: true, cleared: true };
  }

  const result: InferenceResult = await materializeInferences(adapter, graphUri);
  await persistGraph(adapter, config, graphUri);
  return result;
}
