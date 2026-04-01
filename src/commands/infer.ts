import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { materializeInferences, clearInferences } from '../lib/reasoner.js';

export function registerInfer(program: Command): void {
  program
    .command('infer')
    .description('Run RDFS inference on the project graph')
    .option('--clear', 'Clear the inference graph')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (opts: { clear?: boolean; graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      try {
        if (opts.clear) {
          await clearInferences(config.endpoint, graphUri);
          console.log(pc.green('Cleared inference graph'));
          return;
        }

        const result = await materializeInferences(config.endpoint, graphUri);
        console.log(pc.green(`Inferred ${pc.cyan(String(result.inferredCount))} triples`));

        const activeRules = Object.entries(result.rules).filter(([, n]) => n > 0);
        if (activeRules.length > 0) {
          const breakdown = activeRules.map(([rule, n]) => `${rule}: ${pc.cyan(String(n))}`).join(', ');
          console.log(breakdown);
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
