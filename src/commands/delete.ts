import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { deleteTriples } from '../lib/oxigraph.js';

export function registerDelete(program: Command): void {
  program
    .command('delete [file]')
    .description('Delete specific triples from the project graph')
    .option('--where <pattern>', 'SPARQL WHERE pattern for pattern-based deletion')
    .action(async (file: string | undefined, opts: { where?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      if (!file && !opts.where) {
        console.error('Provide a Turtle file or --where pattern');
        process.exit(1);
      }

      try {
        if (file) {
          const content = readFileSync(file, 'utf-8');
          await deleteTriples(config.endpoint, config.graphUri, { turtle: content });
          console.log(`Deleted triples from ${file}`);
        } else if (opts.where) {
          await deleteTriples(config.endpoint, config.graphUri, { where: opts.where });
          console.log('Deleted triples matching pattern');
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
