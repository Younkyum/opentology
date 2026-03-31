import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../lib/config.js';
import { getGraphTripleCount } from '../lib/oxigraph.js';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show project status and triplestore info')
    .action(async () => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      console.log(`${pc.cyan('Project:')}   ${config.projectId}`);
      console.log(`${pc.cyan('Graph URI:')} ${config.graphUri}`);
      console.log(`${pc.cyan('Endpoint:')}  ${config.endpoint}`);

      try {
        const count = await getGraphTripleCount(config.endpoint, config.graphUri);
        console.log(`${pc.cyan('Triples:')}   ${count}`);
      } catch {
        console.log(
          `${pc.cyan('Triples:')}   Cannot connect to Oxigraph at ${config.endpoint}. Is it running? Start with: docker compose up -d`
        );
      }
    });
}
