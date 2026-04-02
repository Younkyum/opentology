import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, saveConfig, configExists, resolveGraphUri } from '../lib/config.js';
import type { OpenTologyConfig } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import type { StoreAdapter } from '../lib/store-adapter.js';
import { hasGraphScope, autoScopeQuery, getInferenceGraphUri } from '../lib/sparql-utils.js';
import { validateTurtle } from '../lib/validator.js';
import { discoverShapes, validateWithShacl, hasShapes } from '../lib/shacl.js';
import { materializeInferences, clearInferences } from '../lib/reasoner.js';
import type { InferenceResult } from '../lib/reasoner.js';

export const MAX_TRIPLES_PER_PUSH = 100;

export function assertTripleLimit(tripleCount: number): void {
  if (tripleCount > MAX_TRIPLES_PER_PUSH) {
    throw new Error(
      `Too many triples (${tripleCount}). Maximum is ${MAX_TRIPLES_PER_PUSH} per push. Split your data into smaller batches.`
    );
  }
}

function resolveConfig(params: { endpoint?: string; graphUri?: string; graph?: string }): { config: OpenTologyConfig; graphUri: string } {
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

async function handleInit(args: Record<string, unknown>): Promise<unknown> {
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

async function handleValidate(args: Record<string, unknown>): Promise<unknown> {
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

async function handlePush(args: Record<string, unknown>): Promise<unknown> {
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
    await adapter.dropGraph(graphUri);
  }

  await adapter.insertTurtle(graphUri, content);

  const infer = args.infer as boolean | undefined;
  let inference: InferenceResult | undefined;
  if (infer !== false) {
    inference = await materializeInferences(adapter, graphUri);
  }

  return {
    success: true,
    tripleCount: validation.tripleCount,
    replaced: !!replace,
    ...(inference ? { inferredCount: inference.inferredCount, inferenceRules: inference.rules } : {}),
  };
}

function injectPrefixes(sparql: string, prefixes: Record<string, string>): string {
  const lines = Object.entries(prefixes)
    .filter(([prefix]) => {
      const re = new RegExp(`PREFIX\\s+${prefix}\\s*:`, 'i');
      return !re.test(sparql);
    })
    .map(([prefix, uri]) => `PREFIX ${prefix}: <${uri}>`);
  if (lines.length === 0) return sparql;
  return lines.join('\n') + '\n' + sparql;
}

async function handleQuery(args: Record<string, unknown>): Promise<unknown> {
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

async function handleStatus(args: Record<string, unknown>): Promise<unknown> {
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

async function handlePull(args: Record<string, unknown>): Promise<unknown> {
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  const turtle = await adapter.exportGraph(graphUri);
  return turtle;
}

async function handleSchema(args: Record<string, unknown>): Promise<unknown> {
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

async function handleDrop(args: Record<string, unknown>): Promise<unknown> {
  const confirm = args.confirm as boolean;
  if (!confirm) {
    throw new Error('Drop requires confirm: true to prevent accidental deletion.');
  }

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  await adapter.dropGraph(graphUri);
  return { success: true, graphUri };
}

async function handleDelete(args: Record<string, unknown>): Promise<unknown> {
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
  await adapter.deleteTriples(graphUri, { turtle: content, where });
  return { success: true };
}

async function handleDiff(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string;
  if (!content) {
    throw new Error('content (Turtle) is required');
  }

  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);
  return await adapter.diffGraph(graphUri, content);
}

async function handleGraphList(_args: Record<string, unknown>): Promise<unknown> {
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

async function handleGraphCreate(args: Record<string, unknown>): Promise<unknown> {
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

async function handleGraphDrop(args: Record<string, unknown>): Promise<unknown> {
  const name = args.name as string;
  const confirm = args.confirm as boolean;
  if (!name) {
    throw new Error('name is required');
  }
  if (!confirm) {
    throw new Error('Graph drop requires confirm: true to prevent accidental deletion.');
  }

  const config = loadConfig();
  const graphUri = resolveGraphUri(config, name);
  const adapter = await createReadyAdapter(config);

  await adapter.dropGraph(graphUri);

  const graphs = config.graphs ?? {};
  delete graphs[name];
  config.graphs = Object.keys(graphs).length > 0 ? graphs : undefined;
  saveConfig(config);

  return { success: true, name, graphUri };
}

async function handleInfer(args: Record<string, unknown>): Promise<unknown> {
  const clear = args.clear as boolean | undefined;
  const { config, graphUri } = resolveConfig({
    graphUri: args.graphUri as string | undefined,
    graph: args.graph as string | undefined,
  });

  const adapter = await createReadyAdapter(config);

  if (clear) {
    await clearInferences(adapter, graphUri);
    return { success: true, cleared: true };
  }

  const result: InferenceResult = await materializeInferences(adapter, graphUri);
  return result;
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'opentology', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'opentology://schema',
        name: 'Ontology Schema Overview',
        description: 'Prefix mappings, class list, and property list for the current project graph. Lightweight summary for SPARQL query context.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'opentology://schema') {
      try {
        const { config, graphUri } = resolveConfig({});
        const adapter = await createReadyAdapter(config);
        const overview = await adapter.getSchemaOverview(graphUri);
        return {
          contents: [
            {
              uri: 'opentology://schema',
              mimeType: 'application/json',
              text: JSON.stringify(overview, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: 'opentology://schema',
              mimeType: 'text/plain',
              text: `Error loading schema: ${(error as Error).message}`,
            },
          ],
        };
      }
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'opentology_init',
        description: 'Initialize a new OpenTology project. Creates .opentology.json config with the project ID, SPARQL endpoint, and named graph URI. Must be run before other tools if no config exists.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            projectId: {
              type: 'string',
              description: 'Unique identifier for the project (used in the graph URI)',
            },
            mode: {
              type: 'string',
              enum: ['http', 'embedded'],
              description: 'Store mode: http (needs SPARQL server) or embedded (no server needed). Default: http',
            },
            endpoint: {
              type: 'string',
              description: 'SPARQL endpoint URL (default: http://localhost:7878, only used in http mode)',
            },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'opentology_validate',
        description: 'Validate Turtle (RDF) content for syntax correctness. Returns triple count and prefixes if valid, or an error message if invalid. Use before pushing to catch errors early. When shacl is true, also validates against SHACL shapes in shapes/ directory.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content to validate',
            },
            shacl: {
              type: 'boolean',
              description: 'If true, also validate against SHACL shapes in shapes/ directory',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'opentology_push',
        description: 'Validate and insert Turtle (RDF) triples into the project graph. Validates syntax first, then pushes to the SPARQL endpoint. Auto-validates against SHACL shapes when shapes/ directory exists. Returns success status and triple count. IMPORTANT: Maximum 100 triples per call. For larger datasets, split into multiple pushes of 20-50 triples each.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content to insert',
            },
            replace: {
              type: 'boolean',
              description: 'If true, drop the entire graph before inserting (replace mode)',
            },
            shacl: {
              type: 'boolean',
              description: 'Set to false to skip SHACL validation. When shapes exist and this is not explicitly false, SHACL validation runs automatically.',
            },
            infer: {
              type: 'boolean',
              description: 'Set to false to skip RDFS inference after push. Defaults to true.',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'opentology_query',
        description: 'Execute a SPARQL query against the project graph. Automatically scopes unscoped queries to the project named graph unless raw mode is enabled.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            sparql: {
              type: 'string',
              description: 'SPARQL query string',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
            raw: {
              type: 'boolean',
              description: 'If true, skip automatic graph scoping and send the query as-is',
            },
          },
          required: ['sparql'],
        },
      },
      {
        name: 'opentology_status',
        description: 'Get the current status of the OpenTology project, including project ID, endpoint, graph URI, and the number of triples stored in the graph.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'opentology_pull',
        description: 'Export the entire project graph as Turtle (RDF). Returns all triples from the named graph serialized in Turtle format.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'opentology_schema',
        description: 'Inspect the ontology schema. Without parameters, returns all classes and properties (same as opentology://schema resource). With a class parameter, returns detailed info: instance count, properties used by that class, and sample triples.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            class: {
              type: 'string',
              description: 'URI of a specific class to inspect (e.g., "http://schema.org/Person"). If omitted, returns the full schema overview.',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'opentology_drop',
        description: 'Drop (delete) the entire project graph. Requires confirm: true to prevent accidental deletion.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            confirm: {
              type: 'boolean',
              description: 'Must be true to confirm graph deletion',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
          required: ['confirm'],
        },
      },
      {
        name: 'opentology_delete',
        description: 'Delete specific triples. Provide Turtle content to remove those exact triples, or a SPARQL WHERE pattern for pattern-based deletion.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content specifying triples to delete',
            },
            where: {
              type: 'string',
              description: 'SPARQL WHERE pattern for pattern-based deletion (e.g., "?s a <http://schema.org/Person>")',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'opentology_diff',
        description: 'Compare local Turtle content against the remote graph. Returns added triples (in local but not remote), removed triples (in remote but not local), and count of unchanged triples.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content to compare against the remote graph',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'opentology_graph_list',
        description: 'List all named graphs for the project. Shows graph name, URI, and triple count.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'opentology_graph_create',
        description: 'Create a new named graph. Generates a URI based on the project graph URI and registers it in the config.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: {
              type: 'string',
              description: 'Logical name for the new graph',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'opentology_graph_drop',
        description: 'Drop a named graph and remove it from config. Requires confirm: true to prevent accidental deletion.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: {
              type: 'string',
              description: 'Logical name of the graph to drop',
            },
            confirm: {
              type: 'boolean',
              description: 'Must be true to confirm graph deletion',
            },
          },
          required: ['name', 'confirm'],
        },
      },
      {
        name: 'opentology_infer',
        description: 'Run RDFS inference on the project graph, materializing inferred triples into the main graph (so queries work naturally). A bookkeeping copy is kept in the inference graph for status reporting and clear support. With clear: true, removes inferred triples from both graphs.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            clear: {
              type: 'boolean',
              description: 'If true, clear the inference graph instead of materializing',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by opentology_graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: unknown;
      switch (name) {
        case 'opentology_init':
          result = await handleInit(args as Record<string, unknown>);
          break;
        case 'opentology_validate':
          result = await handleValidate(args as Record<string, unknown>);
          break;
        case 'opentology_push':
          result = await handlePush(args as Record<string, unknown>);
          break;
        case 'opentology_query':
          result = await handleQuery(args as Record<string, unknown>);
          break;
        case 'opentology_status':
          result = await handleStatus(args as Record<string, unknown>);
          break;
        case 'opentology_pull':
          result = await handlePull(args as Record<string, unknown>);
          break;
        case 'opentology_schema':
          result = await handleSchema(args as Record<string, unknown>);
          break;
        case 'opentology_drop':
          result = await handleDrop(args as Record<string, unknown>);
          break;
        case 'opentology_delete':
          result = await handleDelete(args as Record<string, unknown>);
          break;
        case 'opentology_diff':
          result = await handleDiff(args as Record<string, unknown>);
          break;
        case 'opentology_graph_list':
          result = await handleGraphList(args as Record<string, unknown>);
          break;
        case 'opentology_graph_create':
          result = await handleGraphCreate(args as Record<string, unknown>);
          break;
        case 'opentology_graph_drop':
          result = await handleGraphDrop(args as Record<string, unknown>);
          break;
        case 'opentology_infer':
          result = await handleInfer(args as Record<string, unknown>);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
