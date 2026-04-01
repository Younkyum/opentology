import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { insertTurtle, dropGraph } from '../lib/oxigraph.js';
import { validateTurtleFile } from '../lib/validator.js';
import { discoverShapes, validateWithShacl, hasShapes } from '../lib/shacl.js';

export function registerPush(program: Command): void {
  program
    .command('push <file>')
    .description('Push a Turtle file to the triplestore')
    .option('--replace', 'Replace entire graph contents (drop + push)')
    .option('--no-shacl', 'Skip SHACL validation')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (file: string, opts: { replace?: boolean; shacl?: boolean; graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      try {
        const result = await validateTurtleFile(file);

        if (!result.valid) {
          console.error(`Validation failed: ${result.error}`);
          process.exit(1);
        }

        const turtle = readFileSync(file, 'utf-8');

        // Auto-validate against SHACL when shapes exist (unless --no-shacl)
        if (opts.shacl !== false && hasShapes()) {
          const shapePaths = discoverShapes();
          const report = await validateWithShacl(turtle, shapePaths);
          if (!report.conforms) {
            for (const v of report.violations) {
              console.error(pc.red(`SHACL Violation: ${v.focusNode} — ${v.message} (path: ${v.path})`));
            }
            process.exit(1);
          }
          console.log('SHACL: conforms');
        }

        if (opts.replace) {
          await dropGraph(config.endpoint, graphUri);
        }

        await insertTurtle(config.endpoint, graphUri, turtle);

        if (opts.replace) {
          console.log(pc.green(`Replaced graph with ${result.tripleCount} triples`));
        } else {
          console.log(pc.green(`Pushed ${result.tripleCount} triples to ${graphUri}`));
        }
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
          console.error(
            `Cannot connect to Oxigraph at ${config.endpoint}. Is it running? Start with: docker compose up -d`
          );
        } else {
          console.error(`Error: ${message}`);
        }
        process.exit(1);
      }
    });
}
