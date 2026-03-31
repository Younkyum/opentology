import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, saveConfig, configExists } from '../lib/config.js';
import type { OpenTologyConfig } from '../lib/config.js';
import { sparqlQuery, insertTurtle, getGraphTripleCount, exportGraph, hasGraphScope, autoScopeQuery } from '../lib/oxigraph.js';
import { validateTurtle } from '../lib/validator.js';

function resolveConfig(params: { endpoint?: string; graphUri?: string }): { endpoint: string; graphUri: string } {
  if (params.endpoint && params.graphUri) {
    return { endpoint: params.endpoint, graphUri: params.graphUri };
  }
  try {
    const config = loadConfig();
    return {
      endpoint: params.endpoint || config.endpoint,
      graphUri: params.graphUri || config.graphUri,
    };
  } catch {
    throw new Error('No config found. Either pass endpoint and graphUri parameters, or run opentology init first.');
  }
}

async function handleInit(args: Record<string, unknown>): Promise<unknown> {
  const projectId = args.projectId as string;
  const endpoint = (args.endpoint as string) || 'http://localhost:7878';

  if (configExists()) {
    throw new Error('Project already initialized. .opentology.json exists in the current directory.');
  }

  const graphUri = `https://opentology.dev/${projectId}`;
  const config: OpenTologyConfig = { projectId, endpoint, graphUri };
  saveConfig(config);

  return { projectId, endpoint, graphUri };
}

async function handleValidate(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string;
  return await validateTurtle(content);
}

async function handlePush(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content as string;
  const validation = await validateTurtle(content);
  if (!validation.valid) {
    throw new Error(`Invalid Turtle: ${validation.error}`);
  }

  const { endpoint, graphUri } = resolveConfig({
    endpoint: args.endpoint as string | undefined,
    graphUri: args.graphUri as string | undefined,
  });

  await insertTurtle(endpoint, graphUri, content);
  return { success: true, tripleCount: validation.tripleCount };
}

async function handleQuery(args: Record<string, unknown>): Promise<unknown> {
  const sparql = args.sparql as string;
  const raw = args.raw as boolean | undefined;

  const { endpoint, graphUri } = resolveConfig({
    endpoint: args.endpoint as string | undefined,
    graphUri: args.graphUri as string | undefined,
  });

  let query = sparql;
  if (!raw && !hasGraphScope(sparql)) {
    const scoped = autoScopeQuery(sparql, graphUri);
    if (scoped) {
      query = scoped;
    }
  }

  return await sparqlQuery(endpoint, query);
}

async function handleStatus(args: Record<string, unknown>): Promise<unknown> {
  const { endpoint, graphUri } = resolveConfig({
    endpoint: args.endpoint as string | undefined,
    graphUri: args.graphUri as string | undefined,
  });

  let projectId = 'unknown';
  try {
    const config = loadConfig();
    projectId = config.projectId;
  } catch {
    // config not available, keep "unknown"
  }

  const tripleCount = await getGraphTripleCount(endpoint, graphUri);
  return { projectId, endpoint, graphUri, tripleCount };
}

async function handlePull(args: Record<string, unknown>): Promise<unknown> {
  const { endpoint, graphUri } = resolveConfig({
    endpoint: args.endpoint as string | undefined,
    graphUri: args.graphUri as string | undefined,
  });

  const turtle = await exportGraph(endpoint, graphUri);
  return turtle;
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'opentology', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

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
            endpoint: {
              type: 'string',
              description: 'SPARQL endpoint URL (default: http://localhost:7878)',
            },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'opentology_validate',
        description: 'Validate Turtle (RDF) content for syntax correctness. Returns triple count and prefixes if valid, or an error message if invalid. Use before pushing to catch errors early.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content to validate',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'opentology_push',
        description: 'Validate and insert Turtle (RDF) triples into the project graph. Validates syntax first, then pushes to the SPARQL endpoint. Returns success status and triple count.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content to insert',
            },
            endpoint: {
              type: 'string',
              description: 'SPARQL endpoint URL (uses config default if omitted)',
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
            endpoint: {
              type: 'string',
              description: 'SPARQL endpoint URL (uses config default if omitted)',
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
            endpoint: {
              type: 'string',
              description: 'SPARQL endpoint URL (uses config default if omitted)',
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
            endpoint: {
              type: 'string',
              description: 'SPARQL endpoint URL (uses config default if omitted)',
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
