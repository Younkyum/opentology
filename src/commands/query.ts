import { Command } from 'commander';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import { hasGraphScope, autoScopeQuery } from '../lib/sparql-utils.js';

function injectPrefixes(sparql: string, prefixes: Record<string, string>): string {
  const lines = Object.entries(prefixes)
    .filter(([prefix]) => {
      // Skip if the query already declares this prefix
      const re = new RegExp(`PREFIX\\s+${prefix}\\s*:`, 'i');
      return !re.test(sparql);
    })
    .map(([prefix, uri]) => `PREFIX ${prefix}: <${uri}>`);
  if (lines.length === 0) return sparql;
  return lines.join('\n') + '\n' + sparql;
}

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

function formatCsv(vars: string[], bindings: Array<Record<string, { type: string; value: string }>>): string {
  const header = vars.join(',');
  const rows = bindings.map(row =>
    vars.map(v => {
      const val = row[v]?.value ?? '';
      // Escape values containing commas, quotes, or newlines
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

export function registerQuery(program: Command): void {
  program
    .command('query <sparql>')
    .description('Run a SPARQL query against the triplestore')
    .option('--format <type>', 'Output format: table, json, csv', 'table')
    .option('--json', 'Output raw JSON (alias for --format json)')
    .option('--raw', 'Skip automatic Named Graph scoping')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (sparql: string, options: { format?: string; json?: boolean; raw?: boolean; graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = options.graph ? resolveGraphUri(config, options.graph) : config.graphUri;

      // Resolve format: --json flag overrides --format
      const format = options.json ? 'json' : (options.format || 'table');

      // Inject project-level PREFIX declarations from config
      let effectiveSparql = sparql;
      if (config.prefixes) {
        effectiveSparql = injectPrefixes(effectiveSparql, config.prefixes);
      }

      // Auto-scope the query to the project's Named Graph unless the user
      // has already specified graph scoping or passed --raw.
      if (!options.raw && !hasGraphScope(effectiveSparql)) {
        const scoped = autoScopeQuery(effectiveSparql, graphUri);
        if (scoped !== null) {
          effectiveSparql = scoped;
        } else {
          // Transformation failed — run as-is and warn.
          console.warn(`Warning: could not auto-scope query. Add GRAPH <${graphUri}> manually or use --raw.`);
        }
      }

      try {
        const adapter = await createReadyAdapter(config);
        const results = await adapter.sparqlQuery(effectiveSparql);

        switch (format) {
          case 'json':
            console.log(JSON.stringify(results, null, 2));
            break;
          case 'csv':
            console.log(formatCsv(results.head.vars, results.results.bindings));
            break;
          default: {
            const output = formatTable(results.head.vars, results.results.bindings);
            console.log(output);

            if (results.results.bindings.length === 0) {
              console.log(`\nHint: use GRAPH <${graphUri}> in your WHERE clause`);
            }
            break;
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        console.error(`Error: ${message}`);
        if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
          console.error(
            `Cannot connect to triplestore at ${config.endpoint ?? 'unknown'}. Is it running? Start with: docker compose up -d`
          );
        }
        if (message.toLowerCase().includes('parse') && sparql.includes('\\!')) {
          console.error(
            `Hint: if your query contains !=, your shell may have escaped the '!' character. Try wrapping the query in $'...' or use FILTER(?x NOT IN (<uri>)) instead.`
          );
        }
        process.exit(1);
      }
    });
}
