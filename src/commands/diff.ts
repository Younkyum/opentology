import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';

export function registerDiff(program: Command): void {
  program
    .command('diff <file>')
    .description('Show differences between a local Turtle file and the remote graph')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (file: string, opts: { graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      try {
        const adapter = await createReadyAdapter(config);
        const turtle = readFileSync(file, 'utf-8');
        const result = await adapter.diffGraph(graphUri, turtle);

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
            `Cannot connect to Oxigraph at ${config.endpoint ?? 'unknown'}. Is it running? Start with: docker compose up -d`
          );
        } else {
          console.error(`Error: ${message}`);
        }
        process.exit(1);
      }
    });
}
