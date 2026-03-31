import { Command } from 'commander';
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

      console.log(`Project:   ${config.projectId}`);
      console.log(`Graph URI: ${config.graphUri}`);
      console.log(`Endpoint:  ${config.endpoint}`);

      try {
        const count = await getGraphTripleCount(config.endpoint, config.graphUri);
        console.log(`Triples:   ${count}`);
      } catch {
        console.log(`Triples:   (cannot connect to ${config.endpoint})`);
      }
    });
}
