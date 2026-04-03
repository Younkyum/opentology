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
import { loadConfig, saveConfig, configExists, resolveGraphUri } from '../lib/config.js';
import { deepScan } from '../lib/deep-scanner.js';
import { pushSymbolTriples } from '../lib/deep-scan-triples.js';
import type { OpenTologyConfig } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import type { StoreAdapter } from '../lib/store-adapter.js';
import { hasGraphScope, autoScopeQuery, getInferenceGraphUri } from '../lib/sparql-utils.js';
import { validateTurtle } from '../lib/validator.js';
import { discoverShapes, validateWithShacl, hasShapes } from '../lib/shacl.js';
import { materializeInferences, clearInferences } from '../lib/reasoner.js';
import { fromSchemaData, toMermaid, toDot } from '../lib/visualizer.js';
import type { InferenceResult } from '../lib/reasoner.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OTX_BOOTSTRAP_TURTLE } from '../templates/otx-ontology.js';
import { generateContextSection, updateClaudeMd } from '../templates/claude-md-context.js';
import { generateHookScript } from '../templates/session-start-hook.js';
import { generateSlashCommands } from '../templates/slash-commands.js';
import type { ContextLoadOutput } from '../commands/context.js';
import { scanCodebase } from '../lib/codebase-scanner.js';
import { startGraphServer } from '../lib/graph-server.js';

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

async function handleContextScan(args: Record<string, unknown>): Promise<unknown> {
  const depth = (args.depth as string | undefined) ?? 'module';

  if (depth === 'symbol') {
    const scanResult = await deepScan(process.cwd(), {
      maxFiles: args.maxFiles as number | undefined,
      maxSymbols: args.maxSymbols as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
      includeMethodCalls: args.includeMethodCalls as boolean | undefined,
      languages: args.languages as string[] | undefined,
    });

    if (!scanResult.deepScanAvailable) {
      return scanResult;
    }

    // Auto-push triples server-side
    let pushStats: { triplesInserted: number; batchCount: number } | null = null;
    try {
      const config = loadConfig();
      const contextUri = `${config.graphUri}/context`;
      const adapter = await createReadyAdapter(config);
      pushStats = await pushSymbolTriples(adapter, contextUri, scanResult);
    } catch {
      // Non-fatal: push is best-effort
    }

    return {
      ...scanResult,
      pushStats,
      _experimental: true,
      _hint: pushStats
        ? `Symbol triples pushed: ${pushStats.triplesInserted} triples in ${pushStats.batchCount} batches. Query with: SELECT ?c WHERE { ?c a otx:Class ; otx:definedIn <urn:module:...> }`
        : 'Deep scan completed but triple push failed. Use push manually with the generated triples.',
    };
  }

  // Default: module-level scan (existing behavior)
  const maxBytes = (args.maxSnapshotBytes as number | undefined) ?? 15360;
  const snapshot = await scanCodebase(process.cwd(), maxBytes);
  return {
    codebaseSnapshot: snapshot,
    _hint: snapshot.dependencyGraph && snapshot.dependencyGraph.modules.length > 0
      ? 'Analyze codebaseSnapshot and push Knowledge triples via push. Module dependency triples (otx:Module + otx:dependsOn) are available in dependencyGraph — push them to the context graph as-is.'
      : 'Analyze codebaseSnapshot and push Knowledge triples via push. No dependency graph was auto-extracted (non-JS/TS project or parsing issue). Inspect key source files manually and push otx:Module + otx:dependsOn triples for the important modules you identify.',
  };
}

async function handleContextInit(args: Record<string, unknown>): Promise<unknown> {
  const force = args.force as boolean | undefined;
  const config = loadConfig();
  const graphs = config.graphs ?? {};
  const contextUri = `${config.graphUri}/context`;
  const sessionsUri = `${config.graphUri}/sessions`;
  const actions: string[] = [];

  // Create graphs
  if (!graphs['context']) {
    graphs['context'] = contextUri;
    actions.push(`Created graph 'context' -> ${contextUri}`);
  }
  if (!graphs['sessions']) {
    graphs['sessions'] = sessionsUri;
    actions.push(`Created graph 'sessions' -> ${sessionsUri}`);
  }
  config.graphs = graphs;

  // Bootstrap ontology
  const ontologyDir = join(process.cwd(), '.opentology');
  const ontologyPath = join(ontologyDir, 'ontology.ttl');
  if (!existsSync(ontologyPath) || force) {
    mkdirSync(ontologyDir, { recursive: true });
    writeFileSync(ontologyPath, OTX_BOOTSTRAP_TURTLE, 'utf-8');
    if (!config.files) config.files = {};
    if (!config.files[contextUri]) config.files[contextUri] = [];
    const relPath = '.opentology/ontology.ttl';
    if (!config.files[contextUri].includes(relPath)) {
      config.files[contextUri].push(relPath);
    }
    actions.push('Bootstrapped otx ontology (6 classes, 12 properties)');
  }

  // Generate hook script
  const hookDir = join(process.cwd(), '.opentology', 'hooks');
  const hookPath = join(hookDir, 'session-start.mjs');
  if (!existsSync(hookPath) || force) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(hookPath, generateHookScript(), 'utf-8');
    actions.push('Generated hook: .opentology/hooks/session-start.mjs');
  }

  // Update CLAUDE.md
  const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
  const section = generateContextSection(config.projectId, config.graphUri);
  if (!existsSync(claudeMdPath) || force) {
    updateClaudeMd(claudeMdPath, section);
    actions.push('Updated CLAUDE.md with context instructions');
  } else {
    updateClaudeMd(claudeMdPath, section);
    actions.push('Updated CLAUDE.md context section');
  }

  // Generate slash commands
  const commandsDir = join(process.cwd(), '.claude', 'commands');
  const slashCommands = generateSlashCommands();
  mkdirSync(commandsDir, { recursive: true });
  let slashCreated = 0;
  for (const cmd of slashCommands) {
    const cmdPath = join(commandsDir, cmd.filename);
    if (!existsSync(cmdPath) || force) {
      writeFileSync(cmdPath, cmd.content, 'utf-8');
      slashCreated++;
    }
  }
  if (slashCreated > 0) {
    actions.push(`Generated ${slashCreated} slash commands in .claude/commands/`);
  }

  saveConfig(config);

  // Auto-push Module triples from dependency graph
  let moduleStats: { modules: number; edges: number } | null = null;
  try {
    const snapshot = await scanCodebase(process.cwd());
    if (snapshot.dependencyGraph && snapshot.dependencyGraph.modules.length > 0) {
      const dg = snapshot.dependencyGraph;
      const adapter = await createReadyAdapter(config);
      const sparqlTriples: string[] = [];
      for (const mod of dg.modules) {
        sparqlTriples.push(`<urn:module:${mod}> a <https://opentology.dev/vocab#Module> .`);
      }
      for (const edge of dg.edges) {
        sparqlTriples.push(`<urn:module:${edge.from}> <https://opentology.dev/vocab#dependsOn> <urn:module:${edge.to}> .`);
      }
      await adapter.sparqlUpdate(`INSERT DATA { GRAPH <${contextUri}> {\n${sparqlTriples.join('\n')}\n} }`);
      moduleStats = { modules: dg.modules.length, edges: dg.edges.length };
      actions.push(`Pushed ${dg.modules.length} Module triples with ${dg.edges.length} dependsOn edges`);
    }
  } catch {
    // Non-fatal: dependency graph push is best-effort
  }

  const dependencyHint = moduleStats
    ? `Dependency graph pushed: ${moduleStats.modules} modules, ${moduleStats.edges} edges. Query with: SELECT ?affected WHERE { ?affected otx:dependsOn+ <urn:module:...> }`
    : 'No dependency graph auto-extracted (non-JS/TS project or no local imports found). Inspect key source files and manually push otx:Module + otx:dependsOn triples for important modules.';

  return {
    success: true,
    projectId: config.projectId,
    contextGraph: contextUri,
    sessionsGraph: sessionsUri,
    actions,
    moduleStats,
    dependencyHint,
    hookSnippet: {
      hooks: {
        SessionStart: [{
          type: 'command',
          command: 'node .opentology/hooks/session-start.mjs',
        }],
      },
    },
  };
}

async function handleContextLoad(): Promise<ContextLoadOutput> {
  const config = loadConfig();
  const graphs = config.graphs ?? {};
  if (!graphs['context'] || !graphs['sessions']) {
    throw new Error('Context not initialized. Use context_init first.');
  }

  const contextUri = graphs['context'];
  const sessionsUri = graphs['sessions'];
  const adapter = await createReadyAdapter(config);

  const output: ContextLoadOutput = {
    projectId: config.projectId,
    graphUri: config.graphUri,
    sessions: [],
    openIssues: [],
    recentDecisions: [],
    meta: {
      contextTripleCount: 0,
      sessionsTripleCount: 0,
      loadedAt: new Date().toISOString(),
    },
    warnings: [],
  };

  // Query 1: Recent sessions
  try {
    const r = await adapter.sparqlQuery(`
      PREFIX otx: <https://opentology.dev/vocab#>
      SELECT ?session ?title ?date ?nextTodo WHERE {
        GRAPH <${sessionsUri}> {
          ?session a otx:Session ; otx:title ?title ; otx:date ?date .
          OPTIONAL { ?session otx:nextTodo ?nextTodo }
        }
      } ORDER BY DESC(?date) LIMIT 3
    `);
    output.sessions = r.results.bindings.map((b) => ({
      uri: b['session']?.value ?? '',
      title: b['title']?.value ?? '',
      date: b['date']?.value ?? '',
      ...(b['nextTodo']?.value ? { nextTodo: b['nextTodo'].value } : {}),
    }));
  } catch (err) {
    output.warnings!.push(`Sessions query failed: ${(err as Error).message}`);
  }

  // Query 2: Open issues
  try {
    const r = await adapter.sparqlQuery(`
      PREFIX otx: <https://opentology.dev/vocab#>
      SELECT ?issue ?title ?date WHERE {
        GRAPH <${contextUri}> {
          ?issue a otx:Issue ; otx:title ?title ; otx:date ?date ; otx:status "open" .
        }
      } ORDER BY DESC(?date) LIMIT 10
    `);
    output.openIssues = r.results.bindings.map((b) => ({
      uri: b['issue']?.value ?? '',
      title: b['title']?.value ?? '',
      date: b['date']?.value ?? '',
    }));
  } catch (err) {
    output.warnings!.push(`Issues query failed: ${(err as Error).message}`);
  }

  // Query 3: Recent decisions
  try {
    const r = await adapter.sparqlQuery(`
      PREFIX otx: <https://opentology.dev/vocab#>
      SELECT ?decision ?title ?date ?reason WHERE {
        GRAPH <${contextUri}> {
          ?decision a otx:Decision ; otx:title ?title ; otx:date ?date .
          OPTIONAL { ?decision otx:reason ?reason }
        }
      } ORDER BY DESC(?date) LIMIT 3
    `);
    output.recentDecisions = r.results.bindings.map((b) => ({
      uri: b['decision']?.value ?? '',
      title: b['title']?.value ?? '',
      date: b['date']?.value ?? '',
      ...(b['reason']?.value ? { reason: b['reason'].value } : {}),
    }));
  } catch (err) {
    output.warnings!.push(`Decisions query failed: ${(err as Error).message}`);
  }

  try { output.meta.contextTripleCount = await adapter.getGraphTripleCount(contextUri); } catch { /* */ }
  try { output.meta.sessionsTripleCount = await adapter.getGraphTripleCount(sessionsUri); } catch { /* */ }

  if (output.warnings!.length === 0) delete output.warnings;
  return output;
}

async function handleContextStatus(): Promise<unknown> {
  const config = loadConfig();
  const graphs = config.graphs ?? {};
  const hasContext = !!graphs['context'];
  const hasSessions = !!graphs['sessions'];
  const initialized = hasContext && hasSessions;

  const result: Record<string, unknown> = { initialized };

  if (initialized) {
    const adapter = await createReadyAdapter(config);
    result.graphs = {
      context: { uri: graphs['context'], triples: await adapter.getGraphTripleCount(graphs['context']).catch(() => 0) },
      sessions: { uri: graphs['sessions'], triples: await adapter.getGraphTripleCount(graphs['sessions']).catch(() => 0) },
    };
  }

  result.hook = existsSync(join(process.cwd(), '.opentology', 'hooks', 'session-start.mjs'));

  const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    result.claudeMd = 'missing';
  } else {
    const { readFileSync } = await import('node:fs');
    result.claudeMd = readFileSync(claudeMdPath, 'utf-8').includes('OPENTOLOGY:CONTEXT:BEGIN') ? 'markers_present' : 'markers_missing';
  }

  return result;
}

async function handleVisualize(args: Record<string, unknown>): Promise<unknown> {
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

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'opentology', version: '0.1.0' },
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

  // --- MCP Prompts (slash commands) ---
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: unknown;
      switch (name) {
        case 'init':
          result = await handleInit(args as Record<string, unknown>);
          break;
        case 'validate':
          result = await handleValidate(args as Record<string, unknown>);
          break;
        case 'push':
          result = await handlePush(args as Record<string, unknown>);
          break;
        case 'query':
          result = await handleQuery(args as Record<string, unknown>);
          break;
        case 'status':
          result = await handleStatus(args as Record<string, unknown>);
          break;
        case 'pull':
          result = await handlePull(args as Record<string, unknown>);
          break;
        case 'schema':
          result = await handleSchema(args as Record<string, unknown>);
          break;
        case 'drop':
          result = await handleDrop(args as Record<string, unknown>);
          break;
        case 'delete':
          result = await handleDelete(args as Record<string, unknown>);
          break;
        case 'diff':
          result = await handleDiff(args as Record<string, unknown>);
          break;
        case 'graph_list':
          result = await handleGraphList(args as Record<string, unknown>);
          break;
        case 'graph_create':
          result = await handleGraphCreate(args as Record<string, unknown>);
          break;
        case 'graph_drop':
          result = await handleGraphDrop(args as Record<string, unknown>);
          break;
        case 'infer':
          result = await handleInfer(args as Record<string, unknown>);
          break;
        case 'context_scan':
          result = await handleContextScan(args as Record<string, unknown>);
          break;
        case 'context_init':
          result = await handleContextInit(args as Record<string, unknown>);
          break;
        case 'context_load':
          result = await handleContextLoad();
          break;
        case 'context_status':
          result = await handleContextStatus();
          break;
        case 'visualize':
          result = await handleVisualize(args as Record<string, unknown>);
          break;
        case 'context_graph': {
          const port = (args as Record<string, unknown>).port as number | undefined;
          const srv = await startGraphServer({ port });
          result = { url: `http://127.0.0.1:${srv.port}`, port: srv.port, message: `Graph server running at http://127.0.0.1:${srv.port}` };
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
