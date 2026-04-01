import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';

export function registerDelete(program: Command): void {
  program
    .command('delete [file]')
    .description('Delete specific triples from the project graph')
    .option('--where <pattern>', 'SPARQL WHERE pattern for pattern-based deletion')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (file: string | undefined, opts: { where?: string; graph?: string }) => {
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

      if (config.mode === 'embedded') {
        console.error('Delete is not supported in embedded mode — edit your .ttl files directly.');
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      try {
        const adapter = await createReadyAdapter(config);
        if (file) {
          const content = readFileSync(file, 'utf-8');
          await adapter.deleteTriples(graphUri, { turtle: content });
          console.log(pc.green(`Deleted triples from ${file}`));
        } else if (opts.where) {
          await adapter.deleteTriples(graphUri, { where: opts.where });
          console.log(pc.green('Deleted triples matching pattern'));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
