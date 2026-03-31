import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { loadConfig } from '../lib/config.js';
import { diffGraph } from '../lib/oxigraph.js';

export function registerDiff(program: Command): void {
  program
    .command('diff <file>')
    .description('Show differences between a local Turtle file and the remote graph')
    .action(async (file: string) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      try {
        const turtle = readFileSync(file, 'utf-8');
        const result = await diffGraph(config.endpoint, config.graphUri, turtle);

        for (const triple of result.added) {
          console.log(pc.green(`+ ${triple}`));
        }
        for (const triple of result.removed) {
          console.log(pc.red(`- ${triple}`));
        }

        console.log(`\n${result.added.length} added, ${result.removed.length} removed, ${result.unchanged} unchanged`);
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
