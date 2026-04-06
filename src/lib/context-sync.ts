import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenTologyConfig, addTrackedFile, saveConfig } from './config.js';
import { createReadyAdapter } from './store-factory.js';
import { extractDependencyGraph } from './codebase-scanner.js';
import { escapeTurtleLiteral as escapeTurtle } from './sparql-utils.js';

export interface SyncResult {
  sessionsRecovered: number;
  modulesUpdated: boolean;
  moduleStats: { modules: number; edges: number } | null;
  actions: string[];
}

const OTX = 'https://opentology.dev/vocab#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * Get the most recent session date from the sessions graph.
 * Returns ISO date string (YYYY-MM-DD) or null if no sessions exist.
 */
async function getLastSessionDate(
  adapter: Awaited<ReturnType<typeof createReadyAdapter>>,
  sessionsUri: string,
): Promise<string | null> {
  const r = await adapter.sparqlQuery(`
    SELECT ?date WHERE {
      GRAPH <${sessionsUri}> {
        ?s a <${OTX}Session> ; <${OTX}date> ?date .
      }
    } ORDER BY DESC(?date) LIMIT 1
  `);
  const binding = r.results?.bindings?.[0];
  return binding?.date?.value ?? null;
}

/**
 * Get git commits since a given date, grouped by date.
 * Returns map of date -> commit messages.
 */
function getCommitsSince(
  projectRoot: string,
  sinceDate: string | null,
): Map<string, string[]> {
  const dateMap = new Map<string, string[]>();

  try {
    const args = ['log', '--format=%ad|%s', '--date=short'];
    if (sinceDate) {
      args.push(`--after=${sinceDate}`);
    } else {
      args.push('--since=7 days ago');
    }

    const output = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return dateMap;

    for (const line of output.split('\n')) {
      const sepIdx = line.indexOf('|');
      if (sepIdx === -1) continue;
      const date = line.slice(0, sepIdx).trim();
      const msg = line.slice(sepIdx + 1).trim();
      if (!date || !msg) continue;

      if (!dateMap.has(date)) dateMap.set(date, []);
      dateMap.get(date)!.push(msg);
    }
  } catch {
    // git not available or not a repo
  }

  return dateMap;
}

/**
 * Check if any source files changed since a given date.
 */
function hasSourceChanges(projectRoot: string, sinceDate: string | null): boolean {
  if (!sinceDate) return true;

  try {
    const output = execFileSync('git', [
      'log', '--oneline', `--after=${sinceDate}`,
      '--', '*.ts', '*.js', '*.tsx', '*.jsx', '*.py', '*.go', '*.rs', '*.java', '*.swift',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return output.length > 0;
  } catch {
    return true;
  }
}

/**
 * Generate Turtle content for auto-recovered sessions.
 */
function generateSessionTurtle(commitsByDate: Map<string, string[]>): string {
  const lines = [
    `@prefix otx: <${OTX}> .`,
    `@prefix xsd: <${XSD}> .`,
    '',
  ];

  for (const [date, messages] of commitsByDate) {
    const title = messages.length === 1
      ? messages[0]
      : `${messages.length} commits`;
    const body = messages.join('\n');
    const uri = `urn:session:${date}-auto`;

    lines.push(`<${uri}> a otx:Session ;`);
    lines.push(`    otx:title "${escapeTurtle(title)}" ;`);
    lines.push(`    otx:date "${date}"^^xsd:date ;`);
    lines.push(`    otx:body "${escapeTurtle(body)}" .`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate Turtle content for module dependency graph.
 */
function generateModuleTurtle(modules: string[], edges: { from: string; to: string }[]): string {
  const lines = [
    `@prefix otx: <${OTX}> .`,
    '',
  ];

  for (const mod of modules) {
    lines.push(`<urn:module:${mod}> a otx:Module .`);
  }
  lines.push('');

  for (const edge of edges) {
    lines.push(`<urn:module:${edge.from}> otx:dependsOn <urn:module:${edge.to}> .`);
  }

  return lines.join('\n');
}

/**
 * Core sync logic: recover missed sessions and rescan modules.
 * Persists via .ttl files for embedded mode compatibility.
 */
export async function syncContext(
  config: OpenTologyConfig,
  projectRoot: string,
): Promise<SyncResult> {
  const graphs = config.graphs ?? {};
  const contextUri = graphs['context'];
  const sessionsUri = graphs['sessions'];

  if (!contextUri || !sessionsUri) {
    throw new Error('Context not initialized. Run `opentology context init` first.');
  }

  const adapter = await createReadyAdapter(config);
  const actions: string[] = [];
  let sessionsRecovered = 0;
  let modulesUpdated = false;
  let moduleStats: { modules: number; edges: number } | null = null;

  const syncDir = join(projectRoot, '.opentology', 'sync');
  mkdirSync(syncDir, { recursive: true });

  // === Step 1: Recover missed sessions from git log ===
  const lastDate = await getLastSessionDate(adapter, sessionsUri);
  const commitsByDate = getCommitsSince(projectRoot, lastDate);

  if (commitsByDate.size > 0) {
    const turtle = generateSessionTurtle(commitsByDate);
    const sessionsFile = join(syncDir, 'auto-sessions.ttl');

    // Append to existing auto-sessions file or create new
    if (existsSync(sessionsFile)) {
      const existing = readFileSync(sessionsFile, 'utf-8');
      // Only add new sessions (check URIs)
      const newEntries: string[] = [];
      for (const [date] of commitsByDate) {
        const uri = `urn:session:${date}-auto`;
        if (!existing.includes(uri)) {
          newEntries.push(date);
        }
      }
      if (newEntries.length > 0) {
        const newMap = new Map<string, string[]>();
        for (const date of newEntries) {
          newMap.set(date, commitsByDate.get(date)!);
        }
        if (newMap.size > 0) {
          const newTurtle = generateSessionTurtle(newMap);
          // Remove prefix lines from appended content
          const body = newTurtle.split('\n').filter(l => !l.startsWith('@prefix') && l.trim() !== '').join('\n');
          writeFileSync(sessionsFile, existing.trimEnd() + '\n\n' + body + '\n', 'utf-8');
          await adapter.insertTurtle(sessionsUri, newTurtle);
          sessionsRecovered = newMap.size;
        }
      }
    } else {
      writeFileSync(sessionsFile, turtle, 'utf-8');
      await adapter.insertTurtle(sessionsUri, turtle);
      sessionsRecovered = commitsByDate.size;
    }

    if (sessionsRecovered > 0) {
      // Track the file for embedded persistence
      const relPath = '.opentology/sync/auto-sessions.ttl';
      addTrackedFile(config, sessionsUri, relPath);

      const totalCommits = [...commitsByDate.values()].reduce((s, m) => s + m.length, 0);
      actions.push(`Recovered ${sessionsRecovered} session(s) from ${totalCommits} git commit(s)`);
    } else {
      actions.push('No missed sessions to recover');
    }
  } else {
    actions.push('No missed sessions to recover');
  }

  // === Step 2: Rescan module dependency graph if source files changed ===
  const shouldRescan = hasSourceChanges(projectRoot, lastDate);

  if (shouldRescan) {
    try {
      const dg = await extractDependencyGraph(projectRoot, null);
      if (dg.modules.length > 0) {
        const turtle = generateModuleTurtle(dg.modules, dg.edges);
        const modulesFile = join(syncDir, 'modules.ttl');

        // Replace modules file entirely (fresh scan)
        writeFileSync(modulesFile, turtle, 'utf-8');

        // Drop old module triples, then insert fresh
        await adapter.sparqlUpdate(
          `DELETE { GRAPH <${contextUri}> { ?s ?p ?o } } WHERE { GRAPH <${contextUri}> { ?s a <${OTX}Module> . ?s ?p ?o } }`
        );
        await adapter.sparqlUpdate(
          `DELETE { GRAPH <${contextUri}> { ?s <${OTX}dependsOn> ?o } } WHERE { GRAPH <${contextUri}> { ?s <${OTX}dependsOn> ?o } }`
        );
        await adapter.insertTurtle(contextUri, turtle);

        const relPath = '.opentology/sync/modules.ttl';
        addTrackedFile(config, contextUri, relPath);

        moduleStats = { modules: dg.modules.length, edges: dg.edges.length };
        modulesUpdated = true;
        actions.push(`Rescanned modules: ${dg.modules.length} modules, ${dg.edges.length} edges`);
      }
    } catch {
      actions.push('Module rescan failed (non-fatal)');
    }
  } else {
    actions.push('No source changes detected — module rescan skipped');
  }

  // Save config with tracked files
  saveConfig(config);

  return { sessionsRecovered, modulesUpdated, moduleStats, actions };
}

