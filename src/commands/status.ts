import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { getGraphTripleCount } from '../lib/oxigraph.js';
import { getInferenceGraphUri } from '../lib/reasoner.js';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show project status and triplestore info')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (opts: { graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      console.log(`${pc.cyan('Project:')}   ${config.projectId}`);
      console.log(`${pc.cyan('Graph URI:')} ${graphUri}`);
      console.log(`${pc.cyan('Endpoint:')}  ${config.endpoint}`);
      if (opts.graph) {
        console.log(`${pc.cyan('Graph:')}     ${opts.graph}`);
      }

      try {
        const inferenceGraphUri = getInferenceGraphUri(graphUri);
        const assertedCount = await getGraphTripleCount(config.endpoint, graphUri);
        const inferredCount = await getGraphTripleCount(config.endpoint, inferenceGraphUri);
        const totalCount = assertedCount + inferredCount;
        console.log(`${pc.cyan('Triples (asserted):')} ${assertedCount}`);
        console.log(`${pc.cyan('Triples (inferred):')} ${inferredCount}`);
        console.log(`${pc.cyan('Triples (total):')}    ${totalCount}`);
      } catch {
        console.log(
          `${pc.cyan('Triples:')}   Cannot connect to Oxigraph at ${config.endpoint}. Is it running? Start with: docker compose up -d`
        );
      }
    });
}
