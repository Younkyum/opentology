import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import { snapshotGraph } from '../lib/snapshot.js';
import { persistGraph } from '../lib/persist.js';
import { syncContext } from '../lib/context-sync.js';
import { startGraphServer } from '../lib/graph-server.js';
import { generateSlashCommands } from '../templates/slash-commands.js';
import { runDoctor } from '../lib/doctor.js';
import { ask } from '../lib/ask-engine.js';
import { getPackageVersion } from '../lib/version.js';

import { resolveConfig, handleInit, handleValidate, handlePush, handleQuery, handlePull, handleDrop, handleDelete, handleDiff } from './handlers/rdf.js';
import { handleStatus, handleGraphList, handleGraphCreate, handleGraphDrop, handleRollback, handleDoctor, handleAsk } from './handlers/system.js';
import { handleSchema, handleVisualize, handleInfer } from './handlers/schema.js';
import {
  handleContextScan,
  handleContextInit,
  handleContextLoad,
  handleContextSearch,
  handleContextImpact,
  handleContextStatus,
} from './handlers/context.js';

export type { ContextLoadOutput } from './handlers/context.js';

export function getMcpServerIdentity(): { name: string; version: string } {
  return { name: 'opentology', version: getPackageVersion() };
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    getMcpServerIdentity(),
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
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

  const promptDefinitions = generateSlashCommands().map((cmd) => ({
    name: cmd.filename.replace(/\.md$/, ''),
    description: cmd.content.split('\n')[0],
    content: cmd.content,
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: promptDefinitions.map(({ name, description }) => ({
      name,
      description,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const prompt = promptDefinitions.find((p) => p.name === name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: prompt.content },
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'init',
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
        name: 'validate',
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
        name: 'push',
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
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
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
        name: 'query',
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
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
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
        name: 'status',
        description: 'Get the current status of the OpenTology project, including project ID, endpoint, graph URI, and the number of triples stored in the graph.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'pull',
        description: 'Export the entire project graph as Turtle (RDF). Returns all triples from the named graph serialized in Turtle format.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'schema',
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
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'drop',
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
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
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
        name: 'delete',
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
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'diff',
        description: 'Compare local Turtle content against the remote graph. Returns added triples (in local but not remote), removed triples (in remote but not local), and count of unchanged triples. Output is limited to avoid blowing up LLM context windows.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'Turtle (RDF) content to compare against the remote graph',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of added/removed triples to return (default: 50). Total counts are always included.',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
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
        name: 'graph_list',
        description: 'List all named graphs for the project. Shows graph name, URI, and triple count.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'graph_create',
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
        name: 'graph_drop',
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
        name: 'infer',
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
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'context_init',
        description: 'Initialize project context graph for session-based knowledge management. Creates context/sessions named graphs, bootstraps otx ontology vocabulary, generates a Claude Code SessionStart hook script, and updates CLAUDE.md. Idempotent — safe to call multiple times. Use force: true to regenerate hook and CLAUDE.md.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            force: {
              type: 'boolean',
              description: 'Regenerate hook script and CLAUDE.md even if they already exist',
            },
          },
        },
      },
      {
        name: 'context_load',
        description: 'Load project context: recent sessions (last 3), open issues (up to 10), and recent decisions (last 3) from the context graph. Returns structured JSON. Call this at the start of a session to understand project state. Requires context to be initialized first (context_init).',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'context_search',
        description: 'Search the knowledge graph by keywords. Searches across Issues, Decisions, Knowledge, and Patterns by matching keywords against titles and bodies. Use this to find relevant context before investigating code.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to search for (matched with OR logic against title and body).',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'OTX types to search (default: Issue, Decision, Knowledge, Pattern). Use short names without prefix.',
            },
            limit: {
              type: 'number',
              description: 'Maximum results (default: 10).',
            },
          },
          required: ['keywords'],
        },
      },
      {
        name: 'context_status',
        description: 'Check whether project context is initialized. Shows graph triple counts, hook script presence, and CLAUDE.md marker status.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'context_scan',
        description: 'Scan the current project codebase. depth="module" (default) returns a structured snapshot with file-level dependency graph. depth="symbol" (experimental) extracts class/interface/method-level dependencies and auto-pushes OTX triples to the context graph. Supports TypeScript (ts-morph), Python, Go, Rust, Java, Swift (Tree-sitter).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            maxSnapshotBytes: {
              type: 'number',
              description: 'Maximum snapshot payload size in bytes (default: 15360). Only used when depth="module".',
            },
            depth: {
              type: 'string',
              enum: ['module', 'symbol'],
              description: 'Scan depth: "module" for file-level imports (default), "symbol" for class/interface/method-level analysis (experimental, requires ts-morph).',
            },
            maxSymbols: {
              type: 'number',
              description: 'Maximum symbols to extract when depth="symbol" (default: 300).',
            },
            maxFiles: {
              type: 'number',
              description: 'Maximum source files to scan when depth="symbol" (default: 500).',
            },
            timeoutMs: {
              type: 'number',
              description: 'Timeout in milliseconds for symbol scan (default: 30000).',
            },
            includeMethodCalls: {
              type: 'boolean',
              description: 'Extract method call relationships when depth="symbol" (default: false, expensive).',
            },
            languages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Languages to scan when depth="symbol" (e.g. ["typescript", "python", "go", "rust", "java", "swift"]). Auto-detects if omitted.',
            },
          },
        },
      },
      {
        name: 'visualize',
        description: 'Generate a visual diagram of the graph schema. Returns Mermaid or DOT text showing classes, properties, and their relationships (subClassOf, domain/range).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            target: {
              type: 'string',
              enum: ['schema'],
              description: 'What to visualize. Currently only "schema" is supported.',
            },
            format: {
              type: 'string',
              enum: ['mermaid', 'dot'],
              description: 'Output format: mermaid (default) or dot (Graphviz).',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
        },
      },
      {
        name: 'context_graph',
        description: 'Start an interactive graph visualization web server. Opens a local web UI where you can explore classes, instances, and relationships visually. Returns the server URL. The server runs until the process exits.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            port: {
              type: 'number',
              description: 'Server port (default: auto-assigned)',
            },
          },
        },
      },
      {
        name: 'context_impact',
        description: 'Analyze the impact of modifying a file. Returns modules that depend on the target, modules it depends on, and related decisions/issues/knowledge from the context graph. Use this BEFORE editing files to understand the blast radius of changes.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative file path to analyze (e.g., "src/lib/store-factory.ts")',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'context_sync',
        description: 'Auto-sync context graph: recover missed sessions from git log and rescan module dependency graph. Call this at session start to ensure the graph is up to date. Idempotent — safe to call multiple times.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'doctor',
        description: 'Check project health: config, store connectivity, context initialization, hook scripts, Claude Code settings, and optional dependencies. Returns a list of checks with ok/warn/fail status.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'rollback',
        description: 'List or restore graph snapshots. Snapshots are automatically created before destructive operations (drop, delete, scan, etc.). Use action=list to see available snapshots, action=restore with a timestamp to restore.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'restore'],
              description: 'Action: list available snapshots or restore a specific one',
            },
            to: {
              type: 'string',
              description: 'Timestamp of the snapshot to restore (required for action=restore)',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name (as created by graph_create). Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses config default if omitted)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'ask',
        description: 'Evaluate a registered Predicate against the knowledge graph. Predicates are SPARQL templates stored as otx:Predicate in the context graph. Returns a deterministic boolean answer (or null if predicate is unknown or required params are missing). Optionally records the evaluation as otx:Evaluation.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            predicate: {
              type: 'string',
              description: 'Predicate name (e.g. "Module.hasOpenIssue") or full URI (urn:predicate:Module.hasOpenIssue)',
            },
            context: {
              type: 'object' as const,
              description: 'Key-value pairs to bind into the SPARQL template (e.g. { "module": "src/lib/reasoner.ts" })',
              additionalProperties: { type: 'string' },
            },
            record: {
              type: 'boolean',
              description: 'If false, skip recording the evaluation result to the graph. Default: true',
            },
            graph: {
              type: 'string',
              description: 'Logical graph name. Resolves to a graph URI via config.',
            },
            graphUri: {
              type: 'string',
              description: 'Named graph URI (uses context graph if omitted)',
            },
          },
          required: ['predicate', 'context'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: unknown;
      const a = args as Record<string, unknown> ?? {};
      switch (name) {
        case 'init':
          result = await handleInit(a);
          break;
        case 'validate':
          result = await handleValidate(a);
          break;
        case 'push':
          result = await handlePush(a);
          break;
        case 'query':
          result = await handleQuery(a);
          break;
        case 'status':
          result = await handleStatus(a, resolveConfig);
          break;
        case 'pull':
          result = await handlePull(a);
          break;
        case 'schema':
          result = await handleSchema(a, resolveConfig);
          break;
        case 'drop':
          result = await handleDrop(a);
          break;
        case 'delete':
          result = await handleDelete(a);
          break;
        case 'diff':
          result = await handleDiff(a);
          break;
        case 'graph_list':
          result = await handleGraphList(a);
          break;
        case 'graph_create':
          result = await handleGraphCreate(a);
          break;
        case 'graph_drop':
          result = await handleGraphDrop(a);
          break;
        case 'infer':
          result = await handleInfer(a, resolveConfig);
          break;
        case 'context_scan':
          result = await handleContextScan(a);
          break;
        case 'context_init':
          result = await handleContextInit(a);
          break;
        case 'context_load':
          result = await handleContextLoad();
          break;
        case 'context_search':
          result = await handleContextSearch(a);
          break;
        case 'context_status':
          result = await handleContextStatus();
          break;
        case 'visualize':
          result = await handleVisualize(a, resolveConfig);
          break;
        case 'context_graph': {
          const port = a.port as number | undefined;
          const srv = await startGraphServer({ port });
          result = { url: `http://localhost:${srv.port}`, port: srv.port, message: `Graph server running at http://localhost:${srv.port}` };
          break;
        }
        case 'context_impact':
          result = await handleContextImpact(a);
          break;
        case 'context_sync': {
          const syncConfig = loadConfig();
          const syncContextUri = `${syncConfig.graphUri}/context`;
          const syncSessionsUri = `${syncConfig.graphUri}/sessions`;
          const syncAdapter = await createReadyAdapter(syncConfig);
          await snapshotGraph(syncAdapter, syncConfig, syncContextUri);
          result = await syncContext(syncConfig, process.cwd());
          await persistGraph(syncAdapter, syncConfig, syncContextUri);
          await persistGraph(syncAdapter, syncConfig, syncSessionsUri);
          break;
        }
        case 'rollback':
          result = await handleRollback(a, resolveConfig);
          break;
        case 'doctor':
          result = await runDoctor();
          break;
        case 'ask': {
          const askConfig = loadConfig();
          const askGraphUri = a.graphUri as string
            || (a.graph ? resolveGraphUri(askConfig, a.graph as string) : `${askConfig.graphUri}/context`);
          const askAdapter = await createReadyAdapter(askConfig);
          result = await ask(askAdapter, askGraphUri, {
            predicate: a.predicate as string,
            context: (a.context as Record<string, string>) || {},
            record: a.record as boolean | undefined,
          });
          if ((result as { evaluationUri?: string }).evaluationUri) {
            await persistGraph(askAdapter, askConfig, askGraphUri);
          }
          break;
        }
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
