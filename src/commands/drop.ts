import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { dropGraph } from '../lib/oxigraph.js';

export function registerDrop(program: Command): void {
  program
    .command('drop')
    .description('Drop (delete) the entire project graph')
    .option('--force', 'Skip confirmation and drop immediately')
    .action(async (opts: { force?: boolean }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      if (!opts.force) {
        console.error(
          `This will delete all triples in ${config.graphUri}. Use --force to confirm.`
        );
        process.exit(1);
      }

      try {
        await dropGraph(config.endpoint, config.graphUri);
        console.log(`Dropped graph ${config.graphUri}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
