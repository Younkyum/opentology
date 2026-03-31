import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { sparqlQuery, hasGraphScope, autoScopeQuery } from '../lib/oxigraph.js';

function formatTable(vars: string[], bindings: Array<Record<string, { type: string; value: string }>>): string {
  if (bindings.length === 0) {
    return '(no results)';
  }

  // Calculate column widths
  const widths: Record<string, number> = {};
  for (const v of vars) {
    widths[v] = v.length;
  }
  for (const row of bindings) {
    for (const v of vars) {
      const val = row[v]?.value ?? '';
      widths[v] = Math.max(widths[v], val.length);
    }
  }

  // Build header
  const header = vars.map(v => v.padEnd(widths[v])).join('  ');
  const separator = vars.map(v => '-'.repeat(widths[v])).join('  ');

  // Build rows
  const rows = bindings.map(row =>
    vars.map(v => (row[v]?.value ?? '').padEnd(widths[v])).join('  ')
  );

  return [header, separator, ...rows].join('\n');
}

export function registerQuery(program: Command): void {
  program
    .command('query <sparql>')
    .description('Run a SPARQL query against the triplestore')
    .option('--json', 'Output raw JSON')
    .option('--raw', 'Skip automatic Named Graph scoping')
    .action(async (sparql: string, options: { json?: boolean; raw?: boolean }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      // Auto-scope the query to the project's Named Graph unless the user
      // has already specified graph scoping or passed --raw.
      let effectiveSparql = sparql;
      if (!options.raw && !hasGraphScope(sparql)) {
        const scoped = autoScopeQuery(sparql, config.graphUri);
        if (scoped !== null) {
          effectiveSparql = scoped;
        } else {
          // Transformation failed — run as-is and warn.
          console.warn(`Warning: could not auto-scope query. Add GRAPH <${config.graphUri}> manually or use --raw.`);
        }
      }

      try {
        const results = await sparqlQuery(config.endpoint, effectiveSparql);

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          const output = formatTable(results.head.vars, results.results.bindings);
          console.log(output);

          if (results.results.bindings.length === 0) {
            console.log(`\nHint: use GRAPH <${config.graphUri}> in your WHERE clause`);
          }
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
