import { Command } from 'commander';
import pc from 'picocolors';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import { startGraphServer } from '../lib/graph-server.js';
import { OTX_BOOTSTRAP_TURTLE } from '../templates/otx-ontology.js';
import { generateContextSection, updateClaudeMd } from '../templates/claude-md-context.js';
import { generateHookScript } from '../templates/session-start-hook.js';
import { generateSlashCommands } from '../templates/slash-commands.js';

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

export function registerContext(program: Command): void {
  const context = program
    .command('context')
    .description('Manage project context graph for Claude Code integration');

  // --- context init ---
  context
    .command('init')
    .description('Initialize project context graph and Claude Code hook')
    .option('--force', 'Regenerate hook script and CLAUDE.md even if they exist')
    .action(async (opts: { force?: boolean }) => {
      let config;
      try {
        config = loadConfig();
      } catch {
        console.error(pc.red('Error: No .opentology.json found. Run `opentology init` first.'));
        process.exit(1);
      }

      const graphs = config.graphs ?? {};
      const contextUri = `${config.graphUri}/context`;
      const sessionsUri = `${config.graphUri}/sessions`;
      let createdHook = false;
      let createdClaudeMd = false;

      try {
        // Step 1: Create graphs in config
        let graphsChanged = false;
        if (!graphs['context']) {
          graphs['context'] = contextUri;
          graphsChanged = true;
          console.log(pc.green(`  Created graph 'context' -> ${contextUri}`));
        } else {
          console.log(pc.dim(`  Graph 'context' already exists — skipped`));
        }

        if (!graphs['sessions']) {
          graphs['sessions'] = sessionsUri;
          graphsChanged = true;
          console.log(pc.green(`  Created graph 'sessions' -> ${sessionsUri}`));
        } else {
          console.log(pc.dim(`  Graph 'sessions' already exists — skipped`));
        }

        if (graphsChanged) {
          config.graphs = graphs;
        }

        // Step 2: Bootstrap ontology — persist as tracked file for embedded mode
        const ontologyDir = join(process.cwd(), '.opentology');
        const ontologyPath = join(ontologyDir, 'ontology.ttl');

        if (!existsSync(ontologyPath) || opts.force) {
          mkdirSync(ontologyDir, { recursive: true });
          writeFileSync(ontologyPath, OTX_BOOTSTRAP_TURTLE, 'utf-8');

          // Track ontology file so embedded adapter loads it automatically
          if (!config.files) config.files = {};
          if (!config.files[contextUri]) config.files[contextUri] = [];
          const relPath = '.opentology/ontology.ttl';
          if (!config.files[contextUri].includes(relPath)) {
            config.files[contextUri].push(relPath);
          }

          console.log(pc.green('  Bootstrapped otx ontology vocabulary (6 classes, 12 properties)'));
        } else {
          console.log(pc.dim('  Ontology already bootstrapped — skipped'));
        }

        // Create adapter after config is updated with tracked files
        const adapter = await createReadyAdapter(config);

        // Step 3: Write hook script
        const hookDir = join(process.cwd(), '.opentology', 'hooks');
        const hookPath = join(hookDir, 'session-start.mjs');

        if (!existsSync(hookPath) || opts.force) {
          mkdirSync(hookDir, { recursive: true });
          writeFileSync(hookPath, generateHookScript(), 'utf-8');
          createdHook = true;
          console.log(pc.green(`  Generated hook script: .opentology/hooks/session-start.mjs`));
        } else {
          console.log(pc.dim('  Hook script already exists — skipped (use --force to regenerate)'));
        }

        // Step 4: Update CLAUDE.md
        const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
        const section = generateContextSection(config.projectId, config.graphUri);

        if (!existsSync(claudeMdPath) || opts.force) {
          updateClaudeMd(claudeMdPath, section);
          createdClaudeMd = true;
          console.log(pc.green('  Updated CLAUDE.md with context management instructions'));
        } else {
          // Check for markers — update if present, append if not
          const { readFileSync } = await import('node:fs');
          const content = readFileSync(claudeMdPath, 'utf-8');
          if (content.includes('OPENTOLOGY:CONTEXT:BEGIN')) {
            updateClaudeMd(claudeMdPath, section);
            createdClaudeMd = true;
            console.log(pc.green('  Updated CLAUDE.md context section'));
          } else {
            updateClaudeMd(claudeMdPath, section);
            createdClaudeMd = true;
            console.log(pc.green('  Appended context section to CLAUDE.md'));
          }
        }

        // Step 5: Generate slash commands
        const commandsDir = join(process.cwd(), '.claude', 'commands');
        const slashCommands = generateSlashCommands();
        const expectedFilenames = new Set(slashCommands.map((c) => c.filename));
        let slashCreated = 0;
        mkdirSync(commandsDir, { recursive: true });

        // Clean up stale slash command files from previous naming conventions
        if (existsSync(commandsDir)) {
          for (const file of readdirSync(commandsDir)) {
            if (file.endsWith('.md') && !expectedFilenames.has(file) && file.includes('context-')) {
              unlinkSync(join(commandsDir, file));
            }
          }
        }

        for (const cmd of slashCommands) {
          const cmdPath = join(commandsDir, cmd.filename);
          if (!existsSync(cmdPath) || opts.force) {
            writeFileSync(cmdPath, cmd.content, 'utf-8');
            slashCreated++;
          }
        }
        if (slashCreated > 0) {
          console.log(pc.green(`  Generated ${slashCreated} slash commands in .claude/commands/`));
        } else {
          console.log(pc.dim('  Slash commands already exist — skipped'));
        }

        // Step 6: Save config LAST (atomic commit point)
        saveConfig(config);

        // Print hook registration instructions
        console.log('');
        console.log(pc.bold('Add this to your project .claude/settings.json:'));
        console.log('');
        console.log(JSON.stringify({
          hooks: {
            SessionStart: [{
              type: 'command',
              command: 'node .opentology/hooks/session-start.mjs',
            }],
          },
        }, null, 2));
        console.log('');
        console.log(pc.dim('Consider adding .opentology/hooks/ to version control so team members share the hook.'));

      } catch (err) {
        // Rollback: clean up files created in this run
        if (createdHook) {
          const hookPath = join(process.cwd(), '.opentology', 'hooks', 'session-start.mjs');
          try { unlinkSync(hookPath); } catch { /* ignore */ }
        }
        if (createdClaudeMd) {
          // Only delete if we created a new file (not appended to existing)
          const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
          // Don't delete existing CLAUDE.md — too risky. Just warn.
        }
        console.error(pc.red(`Error during context init: ${(err as Error).message}`));
        console.error(pc.dim('Config was NOT modified. Fix the error and retry.'));
        process.exit(1);
      }
    });

  // --- context load ---
  context
    .command('load')
    .description('Load project context (recent sessions, open issues, decisions)')
    .option('--format <type>', 'Output format: table, json', 'table')
    .action(async (opts: { format: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch {
        console.error('Error: No .opentology.json found. Run `opentology init` first.');
        process.exit(1);
      }

      const graphs = config.graphs ?? {};
      if (!graphs['context'] || !graphs['sessions']) {
        console.error('Error: Context not initialized. Run `opentology context init` first.');
        process.exit(1);
      }

      const contextUri = graphs['context'];
      const sessionsUri = graphs['sessions'];

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

      try {
        const adapter = await createReadyAdapter(config);

        // Query 1: Recent sessions
        try {
          const sessionsResult = await adapter.sparqlQuery(`
            PREFIX otx: <https://opentology.dev/vocab#>
            SELECT ?session ?title ?date ?nextTodo WHERE {
              GRAPH <${sessionsUri}> {
                ?session a otx:Session ;
                         otx:title ?title ;
                         otx:date ?date .
                OPTIONAL { ?session otx:nextTodo ?nextTodo }
              }
            } ORDER BY DESC(?date) LIMIT 3
          `);
          output.sessions = sessionsResult.results.bindings.map((b) => ({
            uri: b['session']?.value ?? '',
            title: b['title']?.value ?? '',
            date: b['date']?.value ?? '',
            ...(b['nextTodo']?.value ? { nextTodo: b['nextTodo'].value } : {}),
          }));
        } catch (err) {
          output.warnings!.push(`Failed to query sessions: ${(err as Error).message}`);
        }

        // Query 2: Open issues
        try {
          const issuesResult = await adapter.sparqlQuery(`
            PREFIX otx: <https://opentology.dev/vocab#>
            SELECT ?issue ?title ?date WHERE {
              GRAPH <${contextUri}> {
                ?issue a otx:Issue ;
                       otx:title ?title ;
                       otx:date ?date ;
                       otx:status "open" .
              }
            } ORDER BY DESC(?date) LIMIT 10
          `);
          output.openIssues = issuesResult.results.bindings.map((b) => ({
            uri: b['issue']?.value ?? '',
            title: b['title']?.value ?? '',
            date: b['date']?.value ?? '',
          }));
        } catch (err) {
          output.warnings!.push(`Failed to query issues: ${(err as Error).message}`);
        }

        // Query 3: Recent decisions
        try {
          const decisionsResult = await adapter.sparqlQuery(`
            PREFIX otx: <https://opentology.dev/vocab#>
            SELECT ?decision ?title ?date ?reason WHERE {
              GRAPH <${contextUri}> {
                ?decision a otx:Decision ;
                          otx:title ?title ;
                          otx:date ?date .
                OPTIONAL { ?decision otx:reason ?reason }
              }
            } ORDER BY DESC(?date) LIMIT 3
          `);
          output.recentDecisions = decisionsResult.results.bindings.map((b) => ({
            uri: b['decision']?.value ?? '',
            title: b['title']?.value ?? '',
            date: b['date']?.value ?? '',
            ...(b['reason']?.value ? { reason: b['reason'].value } : {}),
          }));
        } catch (err) {
          output.warnings!.push(`Failed to query decisions: ${(err as Error).message}`);
        }

        // Meta: triple counts
        try {
          output.meta.contextTripleCount = await adapter.getGraphTripleCount(contextUri);
        } catch { /* ignore */ }
        try {
          output.meta.sessionsTripleCount = await adapter.getGraphTripleCount(sessionsUri);
        } catch { /* ignore */ }

        // Clean up empty warnings
        if (output.warnings!.length === 0) delete output.warnings;

      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      if (opts.format === 'json') {
        console.log(JSON.stringify(output, null, 2));
      } else {
        // Table format
        console.log(pc.bold(`Project: ${output.projectId}`));
        console.log('');

        if (output.sessions.length > 0) {
          console.log(pc.bold('Recent Sessions:'));
          for (const s of output.sessions) {
            console.log(`  ${pc.dim(s.date)}  ${s.title}`);
            if (s.nextTodo) console.log(`    ${pc.dim('Next:')} ${s.nextTodo}`);
          }
          console.log('');
        }

        if (output.openIssues.length > 0) {
          console.log(pc.bold(`Open Issues (${output.openIssues.length}):`));
          for (const i of output.openIssues) {
            console.log(`  ${pc.dim(i.date)}  ${i.title}`);
          }
          console.log('');
        }

        if (output.recentDecisions.length > 0) {
          console.log(pc.bold('Recent Decisions:'));
          for (const d of output.recentDecisions) {
            console.log(`  ${pc.dim(d.date)}  ${d.title}`);
          }
          console.log('');
        }

        console.log(pc.dim(`Context: ${output.meta.contextTripleCount} triples | Sessions: ${output.meta.sessionsTripleCount} triples`));
      }
    });

  // --- context status ---
  context
    .command('status')
    .description('Show context initialization status')
    .action(async () => {
      let config;
      try {
        config = loadConfig();
      } catch {
        console.log('Context:     ' + pc.red('not initialized') + ' (no .opentology.json)');
        return;
      }

      const graphs = config.graphs ?? {};
      const hasContext = !!graphs['context'];
      const hasSessions = !!graphs['sessions'];
      const initialized = hasContext && hasSessions;

      console.log('Context:     ' + (initialized ? pc.green('initialized') : pc.red('not initialized')));

      if (initialized) {
        const adapter = await createReadyAdapter(config);

        const contextCount = await adapter.getGraphTripleCount(graphs['context']).catch(() => 0);
        const sessionsCount = await adapter.getGraphTripleCount(graphs['sessions']).catch(() => 0);

        console.log('Graphs:');
        console.log(`  context    ${graphs['context']}   (${contextCount} triples)`);
        console.log(`  sessions   ${graphs['sessions']}  (${sessionsCount} triples)`);
      }

      const hookPath = join(process.cwd(), '.opentology', 'hooks', 'session-start.mjs');
      const hookExists = existsSync(hookPath);
      console.log('Hook:        .opentology/hooks/session-start.mjs ' + (hookExists ? pc.green('(exists)') : pc.red('(missing)')));

      const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
      if (!existsSync(claudeMdPath)) {
        console.log('CLAUDE.md:   ' + pc.red('file missing'));
      } else {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(claudeMdPath, 'utf-8');
        const hasMarkers = content.includes('OPENTOLOGY:CONTEXT:BEGIN');
        console.log('CLAUDE.md:   ' + (hasMarkers ? pc.green('markers present') : pc.yellow('markers missing')));
      }
    });

  // --- context graph ---
  context
    .command('graph')
    .description('Open interactive graph visualization in the browser')
    .option('--port <number>', 'Server port (default: auto)', parseInt)
    .action(async (opts: { port?: number }) => {
      let config;
      try {
        config = loadConfig();
      } catch {
        console.error(pc.red('Error: No .opentology.json found. Run `opentology init` first.'));
        process.exit(1);
      }

      const graphs = config.graphs ?? {};
      if (!graphs['context']) {
        console.error(pc.red('Error: Context not initialized. Run `opentology context init` first.'));
        process.exit(1);
      }

      try {
        const { port } = await startGraphServer({ port: opts.port });
        const url = `http://127.0.0.1:${port}`;
        console.log(pc.green(`Graph server running at ${url}`));

        // Open browser
        const { exec } = await import('node:child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} ${url}`);

        console.log(pc.dim('Press Ctrl+C to stop the server.'));
      } catch (err) {
        console.error(pc.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
