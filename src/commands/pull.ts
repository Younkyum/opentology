import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { exportGraph, getGraphTripleCount } from '../lib/oxigraph.js';

export function registerPull(program: Command): void {
  program
    .command('pull [output]')
    .description('Export graph from triplestore as Turtle')
    .action(async (output?: string) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      try {
        const turtle = await exportGraph(config.endpoint, config.graphUri);
        const count = await getGraphTripleCount(config.endpoint, config.graphUri);

        if (output) {
          writeFileSync(output, turtle, 'utf-8');
          console.log(`Exported ${count} triples to ${output}`);
        } else if (process.stdout.isTTY) {
          // Interactive terminal — write to default file
          const filename = `${config.projectId}.ttl`;
          writeFileSync(filename, turtle, 'utf-8');
          console.log(`Exported ${count} triples to ${filename}`);
        } else {
          // Piped — write turtle to stdout
          process.stdout.write(turtle);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
