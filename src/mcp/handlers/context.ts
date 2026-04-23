import { loadConfig, saveConfig, addTrackedFile } from '../../lib/config.js';
import { createReadyAdapter } from '../../lib/store-factory.js';
import { snapshotGraph } from '../../lib/snapshot.js';
import { persistGraph } from '../../lib/persist.js';
import { escapeTurtleLiteral } from '../../lib/sparql-utils.js';
import { normalizeModuleUri } from '../../lib/module-uri.js';
import { deepScan } from '../../lib/deep-scanner.js';
import { pushSymbolTriples } from '../../lib/deep-scan-triples.js';
import { scanCodebase } from '../../lib/codebase-scanner.js';
import { startGraphServer } from '../../lib/graph-server.js';
import { OTX_BOOTSTRAP_TURTLE } from '../../templates/otx-ontology.js';
import { BUILTIN_PREDICATES_TURTLE } from '../../templates/builtin-predicates.js';
import { generateContextSection, updateClaudeMd, updateGlobalClaudeMd } from '../../templates/claude-md-context.js';
import { generateHookScript } from '../../templates/session-start-hook.js';
import { generatePreEditHookScript } from '../../templates/pre-edit-hook.js';
import { generateUserPromptHookScript } from '../../templates/user-prompt-hook.js';
import { generatePostErrorHookScript } from '../../templates/post-error-hook.js';
import { generateStopSessionHookScript } from '../../templates/stop-session-hook.js';
import { generateSlashCommands } from '../../templates/slash-commands.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ContextLoadOutput {
  projectId: string;
  graphUri: string;
  sessions: Array<{ uri: string; title: string; date: string; nextTodo?: string }>;
  openIssues: Array<{ uri: string; title: string; date: string }>;
  recentDecisions: Array<{ uri: string; title: string; date: string; reason?: string }>;
  meta: {
    contextTripleCount: number;
    sessionsTripleCount: number;
    loadedAt: string;
  };
  warnings?: string[];
}

export async function handleContextScan(args: Record<string, unknown>): Promise<unknown> {
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
    let pushStats: import('../../lib/deep-scan-triples.js').PushResult | null = null;
    let moduleStats: { modules: number; edges: number } | null = null;
    const pushWarnings: string[] = [];
    try {
      const config = loadConfig();
      const contextUri = `${config.graphUri}/context`;
      const adapter = await createReadyAdapter(config);

      // Push symbol triples
      pushStats = await pushSymbolTriples(adapter, contextUri, scanResult);
      if (pushStats.errors.length > 0) {
        pushWarnings.push(...pushStats.errors);
      }

      // Also push module dependency graph (fixes #64)
      const snapshot = await scanCodebase(process.cwd());
      if (snapshot.dependencyGraph && snapshot.dependencyGraph.modules.length > 0) {
        const dg = snapshot.dependencyGraph;
        // Clear stale Module/dependsOn triples
        await adapter.sparqlUpdate(
          `DELETE { GRAPH <${contextUri}> { ?s ?p ?o } } WHERE { GRAPH <${contextUri}> { ?s ?p ?o . { ?s a <https://opentology.dev/vocab#Module> } UNION { ?s <https://opentology.dev/vocab#dependsOn> ?o } } }`,
        );
        const sparqlTriples: string[] = [];
        for (const mod of dg.modules) {
          sparqlTriples.push(`<urn:module:${mod}> a <https://opentology.dev/vocab#Module> ; <https://opentology.dev/vocab#title> "${escapeTurtleLiteral(mod)}" .`);
        }
        for (const edge of dg.edges) {
          sparqlTriples.push(`<urn:module:${edge.from}> <https://opentology.dev/vocab#dependsOn> <urn:module:${edge.to}> .`);
        }
        await adapter.sparqlUpdate(
          `INSERT DATA { GRAPH <${contextUri}> {\n${sparqlTriples.join('\n')}\n} }`,
        );
        moduleStats = { modules: dg.modules.length, edges: dg.edges.length };
      }

      await persistGraph(adapter, config, contextUri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushWarnings.push(`Push failed: ${msg}`);
    }

    const hints: string[] = [];
    if (pushStats) {
      hints.push(`Symbol triples: ${pushStats.triplesInserted} inserted, ${pushStats.triplesFailed} failed, ${pushStats.batchCount} batches`);
      if (pushStats.retryHint) hints.push(pushStats.retryHint);
    }
    if (moduleStats) hints.push(`Module triples: ${moduleStats.modules} modules, ${moduleStats.edges} edges`);
    if (pushWarnings.length > 0) hints.push(...pushWarnings);

    // Build compact summary — do NOT return full symbol arrays (#66)
    const compact: Record<string, unknown> = {
      deepScanAvailable: true,
      counts: {
        classes: scanResult.classes.length,
        interfaces: scanResult.interfaces.length,
        functions: scanResult.functions.length,
        methodCalls: scanResult.methodCalls.length,
        files: scanResult.fileCount,
        symbols: scanResult.symbolCount,
      },
      languageHints: scanResult.languageHints,
      scanDurationMs: scanResult.scanDurationMs,
      capped: scanResult.capped,
      warnings: scanResult.warnings,
      pushStats,
      moduleStats,
      _experimental: true,
      _hint: hints.length
        ? `${hints.join('. ')}. All symbols auto-pushed to graph. Query examples:\n- Classes: SELECT ?c ?name WHERE { ?c a otx:Class ; otx:title ?name }\n- Dependents: SELECT ?dep WHERE { ?dep otx:dependsOn <urn:module:src/lib/store-adapter> }\n- Call graph: SELECT ?caller ?callee WHERE { ?s a otx:MethodCall ; otx:callerSymbol ?caller ; otx:calleeSymbol ?callee }`
        : 'Deep scan completed but triple push failed. Use push manually with the generated triples.',
    };

    // LLM fallback for unsupported languages (#65)
    if (scanResult.unsupportedFiles.length > 0) {
      const samples: Array<{ path: string; language: string; content: string }> = [];
      for (const group of scanResult.unsupportedFiles.slice(0, 5)) {
        const sorted = [...group.files].sort((a, b) => {
          const isEntry = (f: string) => /\/(main|index|app|mod|lib)\.[^/]+$/.test(f) ? 0 : 1;
          return isEntry(a) - isEntry(b);
        });
        for (const file of sorted.slice(0, 2)) {
          try {
            const fullPath = join(process.cwd(), file);
            const raw = readFileSync(fullPath, 'utf-8');
            const lines = raw.split('\n').slice(0, 30).join('\n');
            samples.push({ path: file, language: group.language, content: lines });
          } catch { /* skip unreadable */ }
        }
      }
      compact.unsupportedFiles = scanResult.unsupportedFiles.map(g => ({
        language: g.language,
        extension: g.extension,
        count: g.count,
        files: g.files.slice(0, 5),
      }));
      if (samples.length > 0) {
        compact.samples = samples;
        compact.turtleTemplate = [
          '# Push symbol triples for unsupported language files.',
          '# Replace {filePath} and {Name} with actual values from the samples above.',
          '@prefix otx: <https://opentology.dev/vocab#> .',
          '',
          '# Class/Struct:',
          '# <urn:symbol:{filePath}/class/{Name}> a otx:Class ;',
          '#     otx:title "{Name}" ; otx:definedIn <urn:module:{filePath}> .',
          '',
          '# Function:',
          '# <urn:symbol:{filePath}/function/{name}> a otx:Function ;',
          '#     otx:title "{name}" ; otx:definedIn <urn:module:{filePath}> .',
          '',
          '# Interface/Trait/Protocol:',
          '# <urn:symbol:{filePath}/interface/{Name}> a otx:Interface ;',
          '#     otx:title "{Name}" ; otx:definedIn <urn:module:{filePath}> .',
        ].join('\n');
      }
    }

    return compact;
  }

  // Default: module-level scan — now auto-pushes module triples like context_init
  const maxBytes = (args.maxSnapshotBytes as number | undefined) ?? 15360;
  const snapshot = await scanCodebase(process.cwd(), maxBytes);

  let moduleStats: { modules: number; edges: number } | null = null;
  try {
    const config = loadConfig();
    const contextUri = `${config.graphUri}/context`;
    const adapter = await createReadyAdapter(config);
    if (snapshot.dependencyGraph && snapshot.dependencyGraph.modules.length > 0) {
      const dg = snapshot.dependencyGraph;
      // Snapshot before destructive scan
      await snapshotGraph(adapter, config, contextUri);
      // Scoped delete: clear stale module triples before re-insert
      await adapter.sparqlUpdate(
        `DELETE WHERE { GRAPH <${contextUri}> { ?m a <https://opentology.dev/vocab#Module> . ?m ?p ?o } }`
      );
      // Insert fresh triples
      const sparqlTriples: string[] = [];
      for (const mod of dg.modules) {
        sparqlTriples.push(`<urn:module:${mod}> a <https://opentology.dev/vocab#Module> ; <https://opentology.dev/vocab#title> "${escapeTurtleLiteral(mod)}" .`);
      }
      for (const edge of dg.edges) {
        sparqlTriples.push(`<urn:module:${edge.from}> <https://opentology.dev/vocab#dependsOn> <urn:module:${edge.to}> .`);
      }
      await adapter.sparqlUpdate(
        `INSERT DATA { GRAPH <${contextUri}> {\n${sparqlTriples.join('\n')}\n} }`
      );
      moduleStats = { modules: dg.modules.length, edges: dg.edges.length };
      await persistGraph(adapter, config, contextUri);
    }
  } catch {
    // Non-fatal: module triple push is best-effort
  }

  // Generate language hints for module scan
  const moduleLanguageHints: Array<{ language: string; dependencyModel: string; moduleScanApplicable: boolean; recommendation: string }> = [];
  const fileExtensionMap: Record<string, { lang: string; model: string }> = {
    '.ts': { lang: 'typescript', model: 'file-based' },
    '.tsx': { lang: 'typescript', model: 'file-based' },
    '.js': { lang: 'javascript', model: 'file-based' },
    '.jsx': { lang: 'javascript', model: 'file-based' },
    '.py': { lang: 'python', model: 'file-based' },
    '.rs': { lang: 'rust', model: 'file-based' },
    '.go': { lang: 'go', model: 'package-based' },
    '.java': { lang: 'java', model: 'package-based' },
    '.swift': { lang: 'swift', model: 'framework-based' },
  };
  if (snapshot.dependencyGraph) {
    const detectedLangs = new Set<string>();
    for (const mod of snapshot.dependencyGraph.modules) {
      const ext = '.' + mod.split('.').pop();
      const info = fileExtensionMap[ext];
      if (info && !detectedLangs.has(info.lang)) {
        detectedLangs.add(info.lang);
        const applicable = info.model === 'file-based';
        moduleLanguageHints.push({
          language: info.lang,
          dependencyModel: info.model,
          moduleScanApplicable: applicable,
          recommendation: applicable
            ? 'Module-level dependency graph (depth="module") is applicable.'
            : `This language uses ${info.model} imports — module-level scan is not applicable. Use depth="symbol" for class/method/call-level analysis.`,
        });
      }
    }
  }

  return {
    codebaseSnapshot: snapshot,
    moduleStats,
    languageHints: moduleLanguageHints.length > 0 ? moduleLanguageHints : undefined,
    _hint: moduleStats
      ? `Module triples auto-pushed: ${moduleStats.modules} modules, ${moduleStats.edges} edges. Query with: SELECT ?m WHERE { ?m a otx:Module }`
      : 'No dependency graph auto-extracted or push failed. Inspect key source files manually.',
  };
}

export async function handleContextInit(args: Record<string, unknown>): Promise<unknown> {
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
    actions.push('Bootstrapped otx ontology (15 classes, 29 properties)');
  }

  // Bootstrap built-in predicates
  const predicatesPath = join(ontologyDir, 'predicates.ttl');
  if (!existsSync(predicatesPath) || force) {
    writeFileSync(predicatesPath, BUILTIN_PREDICATES_TURTLE, 'utf-8');
    if (!config.files) config.files = {};
    if (!config.files[contextUri]) config.files[contextUri] = [];
    const predRelPath = '.opentology/predicates.ttl';
    if (!config.files[contextUri].includes(predRelPath)) {
      config.files[contextUri].push(predRelPath);
    }
    actions.push('Bootstrapped 6 built-in predicates for ask() engine');
  }

  // Generate hook script
  const hookDir = join(process.cwd(), '.opentology', 'hooks');
  const hookPath = join(hookDir, 'session-start.mjs');
  if (!existsSync(hookPath) || force) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(hookPath, generateHookScript(), 'utf-8');
    actions.push('Generated hook: .opentology/hooks/session-start.mjs');
  }

  // Generate pre-edit hook script
  const preEditHookPath = join(hookDir, 'pre-edit.mjs');
  if (!existsSync(preEditHookPath) || force) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(preEditHookPath, generatePreEditHookScript(), 'utf-8');
    actions.push('Generated hook: .opentology/hooks/pre-edit.mjs');
  }

  const userPromptHookPath = join(hookDir, 'user-prompt.mjs');
  if (!existsSync(userPromptHookPath) || force) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(userPromptHookPath, generateUserPromptHookScript(), 'utf-8');
    actions.push('Generated hook: .opentology/hooks/user-prompt.mjs');
  }

  const postErrorHookPath = join(hookDir, 'post-error.mjs');
  if (!existsSync(postErrorHookPath) || force) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(postErrorHookPath, generatePostErrorHookScript(), 'utf-8');
    actions.push('Generated hook: .opentology/hooks/post-error.mjs');
  }

  const stopSessionHookPath = join(hookDir, 'stop-session-reminder.mjs');
  if (!existsSync(stopSessionHookPath) || force) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(stopSessionHookPath, generateStopSessionHookScript(), 'utf-8');
    actions.push('Generated hook: .opentology/hooks/stop-session-reminder.mjs');
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

  // Update global ~/.claude/CLAUDE.md
  const homedir = (await import('node:os')).homedir();
  const globalClaudeMdPath = join(homedir, '.claude', 'CLAUDE.md');
  try {
    updateGlobalClaudeMd(globalClaudeMdPath);
    actions.push('Updated global ~/.claude/CLAUDE.md OpenTology section');
  } catch {
    // Non-fatal: global CLAUDE.md update is best-effort
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

  // Auto-register hooks in .claude/settings.json
  const settingsDir = join(process.cwd(), '.claude');
  const settingsPath = join(settingsDir, 'settings.json');
  mkdirSync(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let hooksChanged = false;

  const sessionStartCmd = 'node .opentology/hooks/session-start.mjs';
  if (!hooks.SessionStart) hooks.SessionStart = [];
  const hasSessionHook = hooks.SessionStart.some(
    (h: unknown) => {
      const entry = h as Record<string, unknown>;
      const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
      return entryHooks?.some((hook) => hook.command === sessionStartCmd);
    }
  );
  if (!hasSessionHook) {
    hooks.SessionStart.push({
      matcher: '',
      hooks: [{ type: 'command', command: sessionStartCmd }],
    });
    hooksChanged = true;
  }

  const preEditCmd = 'node .opentology/hooks/pre-edit.mjs';
  if (!hooks.PreToolUse) hooks.PreToolUse = [];
  const hasPreEditHook = hooks.PreToolUse.some(
    (h: unknown) => {
      const entry = h as Record<string, unknown>;
      const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
      return entryHooks?.some((hook) => hook.command === preEditCmd);
    }
  );
  if (!hasPreEditHook) {
    hooks.PreToolUse.push({
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: preEditCmd }],
    });
    hooksChanged = true;
  }

  const userPromptCmd = 'node .opentology/hooks/user-prompt.mjs';
  if (!hooks.UserPromptSubmit) hooks.UserPromptSubmit = [];
  const hasUserPromptHook = hooks.UserPromptSubmit.some(
    (h: unknown) => {
      const entry = h as Record<string, unknown>;
      const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
      return entryHooks?.some((hook) => hook.command === userPromptCmd);
    }
  );
  if (!hasUserPromptHook) {
    hooks.UserPromptSubmit.push({
      matcher: '',
      hooks: [{ type: 'command', command: userPromptCmd }],
    });
    hooksChanged = true;
  }

  const postErrorCmd = 'node .opentology/hooks/post-error.mjs';
  if (!hooks.PostToolUse) hooks.PostToolUse = [];
  const hasPostErrorHook = hooks.PostToolUse.some(
    (h: unknown) => {
      const entry = h as Record<string, unknown>;
      const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
      return entryHooks?.some((hook) => hook.command === postErrorCmd);
    }
  );
  if (!hasPostErrorHook) {
    hooks.PostToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: postErrorCmd }],
    });
    hooksChanged = true;
  }

  const stopSessionCmd = 'node .opentology/hooks/stop-session-reminder.mjs';
  if (!hooks.Stop) hooks.Stop = [];
  const hasStopHook = hooks.Stop.some(
    (h: unknown) => {
      const entry = h as Record<string, unknown>;
      const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
      return entryHooks?.some((hook) => hook.command === stopSessionCmd);
    }
  );
  if (!hasStopHook) {
    hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: stopSessionCmd }],
    });
    hooksChanged = true;
  }

  if (hooksChanged) {
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    actions.push('Auto-registered hooks in .claude/settings.json');
  }

  // Ensure .opentology/snapshots/ is in .gitignore
  const gitignorePath = join(process.cwd(), '.gitignore');
  const snapshotIgnore = '.opentology/snapshots/';
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    if (!gitignoreContent.includes(snapshotIgnore)) {
      writeFileSync(gitignorePath, gitignoreContent.trimEnd() + '\n' + snapshotIgnore + '\n', 'utf-8');
      actions.push('Added .opentology/snapshots/ to .gitignore');
    }
  } else {
    writeFileSync(gitignorePath, snapshotIgnore + '\n', 'utf-8');
    actions.push('Created .gitignore with .opentology/snapshots/');
  }

  // Auto-push Module triples from dependency graph
  let moduleStats: { modules: number; edges: number } | null = null;
  try {
    const snapshot = await scanCodebase(process.cwd());
    if (snapshot.dependencyGraph && snapshot.dependencyGraph.modules.length > 0) {
      const dg = snapshot.dependencyGraph;
      const adapter = await createReadyAdapter(config);
      const sparqlTriples: string[] = [];
      for (const mod of dg.modules) {
        sparqlTriples.push(`<urn:module:${mod}> a <https://opentology.dev/vocab#Module> ; <https://opentology.dev/vocab#title> "${escapeTurtleLiteral(mod)}" .`);
      }
      for (const edge of dg.edges) {
        sparqlTriples.push(`<urn:module:${edge.from}> <https://opentology.dev/vocab#dependsOn> <urn:module:${edge.to}> .`);
      }
      await adapter.sparqlUpdate(`INSERT DATA { GRAPH <${contextUri}> {\n${sparqlTriples.join('\n')}\n} }`);
      moduleStats = { modules: dg.modules.length, edges: dg.edges.length };
      await persistGraph(adapter, config, contextUri);
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
    hooksAutoInstalled: hooksChanged,
    scanSuggestion: 'Run context_scan to populate the knowledge graph. Use depth="module" for file-level dependencies, or depth="symbol" (with includeMethodCalls=true) for class/function/call-level analysis. The symbol scan enables queries like "which functions call persistGraph?" from the graph.',
  };
}

export async function handleContextLoad(): Promise<ContextLoadOutput> {
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

export async function handleContextSearch(args: Record<string, unknown>): Promise<unknown> {
  const keywords = args.keywords as string[];
  if (!keywords || keywords.length === 0) throw new Error('keywords is required (array of strings)');

  const types = (args.types as string[] | undefined) ?? ['Issue', 'Decision', 'Knowledge', 'Pattern'];
  const limit = (args.limit as number | undefined) ?? 10;

  const config = loadConfig();
  const contextUri = `${config.graphUri}/context`;
  const OTX = 'https://opentology.dev/vocab#';
  const adapter = await createReadyAdapter(config);

  const typeFilter = types.map(t => `<${OTX}${t}>`).join(', ');
  const keywordFilters = keywords.map(kw => {
    const escaped = escapeTurtleLiteral(kw.toLowerCase());
    return `CONTAINS(LCASE(?title), "${escaped}") || CONTAINS(LCASE(COALESCE(?body, "")), "${escaped}")`;
  });
  const filterClause = keywordFilters.join(' || ');

  const sparql = `
    PREFIX otx: <${OTX}>
    SELECT ?type ?title ?body ?status ?date ?solution ?cause ?reason WHERE {
      GRAPH <${contextUri}> {
        ?s a ?type .
        ?s otx:title ?title .
        OPTIONAL { ?s otx:body ?body }
        OPTIONAL { ?s otx:status ?status }
        OPTIONAL { ?s otx:date ?date }
        OPTIONAL { ?s otx:solution ?solution }
        OPTIONAL { ?s otx:cause ?cause }
        OPTIONAL { ?s otx:reason ?reason }
        FILTER(
          ?type IN (${typeFilter})
          && (${filterClause})
        )
      }
    } ORDER BY DESC(?date) LIMIT ${limit}
  `;

  const result = await adapter.sparqlQuery(sparql);
  const results = (result.results?.bindings ?? []).map(
    (b: Record<string, { value: string }>) => ({
      type: b.type?.value ?? '',
      title: b.title?.value ?? '',
      body: b.body?.value,
      status: b.status?.value,
      date: b.date?.value,
      solution: b.solution?.value,
      cause: b.cause?.value,
      reason: b.reason?.value,
    })
  );

  return { keywords, results };
}

export async function handleContextImpact(args: Record<string, unknown>): Promise<unknown> {
  const filePath = args.filePath as string;
  if (!filePath) throw new Error('filePath is required');

  const config = loadConfig();
  const contextUri = `${config.graphUri}/context`;
  const adapter = await createReadyAdapter(config);
  const OTX = 'https://opentology.dev/vocab#';
  const moduleUriStr = normalizeModuleUri(filePath);

  // 1. Modules that depend on this file (dependents / reverse deps)
  const dependentsQuery = `
    SELECT ?dependent WHERE {
      GRAPH <${contextUri}> {
        ?dependent <${OTX}dependsOn> <${moduleUriStr}> .
      }
    }`;
  const dependentsResult = await adapter.sparqlQuery(dependentsQuery);
  const dependents = (dependentsResult.results?.bindings ?? []).map(
    (b: Record<string, { value: string }>) => b.dependent?.value?.replace('urn:module:', '') ?? ''
  ).filter(Boolean);

  // 2. Modules this file depends on (dependencies)
  const depsQuery = `
    SELECT ?dep WHERE {
      GRAPH <${contextUri}> {
        <${moduleUriStr}> <${OTX}dependsOn> ?dep .
      }
    }`;
  const depsResult = await adapter.sparqlQuery(depsQuery);
  const dependencies = (depsResult.results?.bindings ?? []).map(
    (b: Record<string, { value: string }>) => b.dep?.value?.replace('urn:module:', '') ?? ''
  ).filter(Boolean);

  // 3. Related decisions, issues, knowledge mentioning this file
  const relatedQuery = `
    SELECT ?type ?title ?status ?date WHERE {
      GRAPH <${contextUri}> {
        ?s <${OTX}body> ?body .
        ?s a ?type .
        ?s <${OTX}title> ?title .
        OPTIONAL { ?s <${OTX}status> ?status }
        OPTIONAL { ?s <${OTX}date> ?date }
        FILTER(CONTAINS(?body, "${escapeTurtleLiteral(filePath)}"))
      }
    } LIMIT 10`;
  let related: Array<{ type: string; title: string; status?: string; date?: string }> = [];
  try {
    const relatedResult = await adapter.sparqlQuery(relatedQuery);
    related = (relatedResult.results?.bindings ?? []).map(
      (b: Record<string, { value: string }>) => ({
        type: b.type?.value?.replace(OTX, '') ?? '',
        title: b.title?.value ?? '',
        status: b.status?.value,
        date: b.date?.value,
      })
    );
  } catch {
    // FILTER/CONTAINS may not be supported — skip gracefully
  }

  const hasDeps = dependents.length > 0 || dependencies.length > 0;

  return {
    filePath,
    moduleUri: moduleUriStr,
    dependents,
    dependencies,
    related,
    impact: dependents.length === 0 ? 'low' : dependents.length <= 3 ? 'medium' : 'high',
    _hint: hasDeps
      ? `This file has ${dependents.length} dependent(s) and ${dependencies.length} dependency(ies). Review dependents before making breaking changes.`
      : 'No module dependencies found in the graph. Run context_scan first to populate module triples.',
  };
}

export async function handleContextStatus(): Promise<unknown> {
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
    const { readFileSync: readSync } = await import('node:fs');
    result.claudeMd = readSync(claudeMdPath, 'utf-8').includes('OPENTOLOGY:CONTEXT:BEGIN') ? 'markers_present' : 'markers_missing';
  }

  return result;
}
