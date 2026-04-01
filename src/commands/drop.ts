import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { dropGraph } from '../lib/oxigraph.js';

export function registerDrop(program: Command): void {
  program
    .command('drop')
    .description('Drop (delete) the entire project graph')
    .option('--force', 'Skip confirmation and drop immediately')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (opts: { force?: boolean; graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      if (!opts.force) {
        console.error(
          pc.red(`This will delete all triples in ${graphUri}. Use --force to confirm.`)
        );
        process.exit(1);
      }

      try {
        await dropGraph(config.endpoint, graphUri);
        console.log(pc.green(`Dropped graph ${graphUri}`));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
