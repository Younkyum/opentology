import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { insertTurtle, dropGraph } from '../lib/oxigraph.js';
import { validateTurtleFile } from '../lib/validator.js';

export function registerPush(program: Command): void {
  program
    .command('push <file>')
    .description('Push a Turtle file to the triplestore')
    .option('--replace', 'Replace entire graph contents (drop + push)')
    .action(async (file: string, opts: { replace?: boolean }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      try {
        const result = await validateTurtleFile(file);

        if (!result.valid) {
          console.error(`Validation failed: ${result.error}`);
          process.exit(1);
        }

        const turtle = readFileSync(file, 'utf-8');

        if (opts.replace) {
          await dropGraph(config.endpoint, config.graphUri);
        }

        await insertTurtle(config.endpoint, config.graphUri, turtle);

        if (opts.replace) {
          console.log(`Replaced graph with ${result.tripleCount} triples`);
        } else {
          console.log(`Pushed ${result.tripleCount} triples to ${config.graphUri}`);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
