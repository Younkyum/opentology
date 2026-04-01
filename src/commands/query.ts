import { Command } from 'commander';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { sparqlQuery, hasGraphScope, autoScopeQuery } from '../lib/oxigraph.js';
import { getInferenceGraphUri } from '../lib/reasoner.js';

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

/**
 * Wraps the WHERE body so it queries both the asserted and inference graphs
 * using a UNION pattern. Returns null if brace matching fails.
 */
function autoScopeQueryWithInference(sparql: string, graphUri: string): string | null {
  const inferenceGraphUri = getInferenceGraphUri(graphUri);

  // Find the WHERE { or first {
  const whereMatch = sparql.match(/\bWHERE\s*\{/i);
  let braceStart: number;

  if (whereMatch && whereMatch.index !== undefined) {
    braceStart = whereMatch.index + whereMatch[0].length - 1;
  } else {
    const firstBrace = sparql.indexOf('{');
    if (firstBrace === -1) return null;
    braceStart = firstBrace;
  }

  // Find matching closing brace
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i++) {
    if (sparql[i] === '{') depth++;
    else if (sparql[i] === '}') {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }

  if (braceEnd === -1) return null;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);

  return `${before} { GRAPH <${graphUri}> {${inner}} } UNION { GRAPH <${inferenceGraphUri}> {${inner}} } ${after}`;
}

export function registerQuery(program: Command): void {
  program
    .command('query <sparql>')
    .description('Run a SPARQL query against the triplestore')
    .option('--format <type>', 'Output format: table, json, csv', 'table')
    .option('--json', 'Output raw JSON (alias for --format json)')
    .option('--raw', 'Skip automatic Named Graph scoping')
    .option('--no-infer', 'Exclude inference graph from auto-scoped queries')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (sparql: string, options: { format?: string; json?: boolean; raw?: boolean; infer?: boolean; graph?: string }) => {
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

      // Auto-scope the query to the project's Named Graph unless the user
      // has already specified graph scoping or passed --raw.
      let effectiveSparql = sparql;
      if (!options.raw && !hasGraphScope(sparql)) {
        const useInference = options.infer !== false;
        const scoped = useInference
          ? autoScopeQueryWithInference(sparql, graphUri)
          : autoScopeQuery(sparql, graphUri);
        if (scoped !== null) {
          effectiveSparql = scoped;
        } else {
          // Transformation failed — run as-is and warn.
          console.warn(`Warning: could not auto-scope query. Add GRAPH <${graphUri}> manually or use --raw.`);
        }
      }

      try {
        const results = await sparqlQuery(config.endpoint, effectiveSparql);

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
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
