import { Command } from 'commander';
import pc from 'picocolors';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configExists, loadConfig } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Config check
  if (!configExists()) {
    results.push({ name: 'Config', status: 'fail', message: 'No .opentology.json found. Run `opentology init` first.' });
    return results; // Can't proceed without config
  }
  const config = loadConfig();
  results.push({ name: 'Config', status: 'ok', message: `Project: ${config.projectId} (${config.mode} mode)` });

  // 2. Store connectivity
  try {
    const adapter = await createReadyAdapter(config);
    const r = await adapter.sparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${config.graphUri}> { ?s ?p ?o } }`);
    const count = r.results?.bindings?.[0]?.c?.value ?? '0';
    results.push({ name: 'Store', status: 'ok', message: `Connected — ${count} triples in default graph` });
  } catch (err) {
    results.push({ name: 'Store', status: 'fail', message: `Cannot connect: ${(err as Error).message}` });
  }

  // 3. Context initialization
  const graphs = config.graphs ?? {};
  if (graphs['context'] && graphs['sessions']) {
    results.push({ name: 'Context', status: 'ok', message: `context: ${graphs['context']}` });
  } else {
    results.push({ name: 'Context', status: 'warn', message: 'Not initialized. Run `opentology context init`.' });
  }

  // 4. Hook scripts
  const hookDir = join(process.cwd(), '.opentology', 'hooks');
  const sessionHook = join(hookDir, 'session-start.mjs');
  const preEditHook = join(hookDir, 'pre-edit.mjs');
  const hooksExist = existsSync(sessionHook) && existsSync(preEditHook);
  if (hooksExist) {
    results.push({ name: 'Hooks', status: 'ok', message: 'session-start.mjs + pre-edit.mjs present' });
  } else {
    results.push({ name: 'Hooks', status: 'warn', message: 'Hook scripts missing. Run `opentology context init`.' });
  }

  // 5. Hook registration in .claude/settings.json
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const hooks = settings.hooks ?? {};
      const hasSession = (hooks.SessionStart ?? []).some(
        (h: Record<string, string>) => h.command?.includes('session-start.mjs')
      );
      const hasPreEdit = (hooks.PreToolUse ?? []).some(
        (h: Record<string, string>) => h.command?.includes('pre-edit.mjs')
      );
      if (hasSession && hasPreEdit) {
        results.push({ name: 'Settings', status: 'ok', message: 'Both hooks registered in .claude/settings.json' });
      } else {
        const missing = [];
        if (!hasSession) missing.push('SessionStart');
        if (!hasPreEdit) missing.push('PreToolUse');
        results.push({ name: 'Settings', status: 'warn', message: `Missing hooks: ${missing.join(', ')}. Run \`opentology context init\`.` });
      }
    } catch {
      results.push({ name: 'Settings', status: 'warn', message: 'Cannot parse .claude/settings.json' });
    }
  } else {
    results.push({ name: 'Settings', status: 'warn', message: 'No .claude/settings.json found. Run `opentology context init`.' });
  }

  // 6. CLAUDE.md
  const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    if (content.includes('OPENTOLOGY:CONTEXT:BEGIN') || content.includes('OpenTology')) {
      results.push({ name: 'CLAUDE.md', status: 'ok', message: 'Context section present' });
    } else {
      results.push({ name: 'CLAUDE.md', status: 'warn', message: 'Exists but no OpenTology context section' });
    }
  } else {
    results.push({ name: 'CLAUDE.md', status: 'warn', message: 'Not found. Run `opentology context init`.' });
  }

  // 7. Optional dependencies
  const optDeps: Array<{ name: string; desc: string }> = [
    { name: 'ts-morph', desc: 'TypeScript deep scan' },
    { name: 'web-tree-sitter', desc: 'Multi-language deep scan' },
  ];
  for (const dep of optDeps) {
    try {
      await import(dep.name);
      results.push({ name: dep.name, status: 'ok', message: dep.desc });
    } catch {
      results.push({ name: dep.name, status: 'warn', message: `Not installed (optional — ${dep.desc})` });
    }
  }

  return results;
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check project health: config, store, context, hooks, dependencies')
    .option('--format <type>', 'Output format: table, json', 'table')
    .action(async (opts: { format: string }) => {
      const results = await runDoctor();

      if (opts.format === 'json') {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log(pc.bold('\nOpenTology Doctor\n'));
      for (const r of results) {
        const icon = r.status === 'ok' ? pc.green('✓') : r.status === 'warn' ? pc.yellow('!') : pc.red('✗');
        const msg = r.status === 'fail' ? pc.red(r.message) : r.status === 'warn' ? pc.yellow(r.message) : r.message;
        console.log(`  ${icon} ${pc.bold(r.name)}: ${msg}`);
      }

      const fails = results.filter((r) => r.status === 'fail').length;
      const warns = results.filter((r) => r.status === 'warn').length;
      console.log('');
      if (fails > 0) {
        console.log(pc.red(`  ${fails} error(s), ${warns} warning(s)`));
        process.exit(1);
      } else if (warns > 0) {
        console.log(pc.yellow(`  ${warns} warning(s), everything else looks good`));
      } else {
        console.log(pc.green('  All checks passed!'));
      }
    });
}
