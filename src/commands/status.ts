import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri, getTrackedFiles } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import { getInferenceGraphUri } from '../lib/sparql-utils.js';

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
      console.log(`${pc.cyan('Mode:')}      ${config.mode}`);
      if (config.endpoint) {
        console.log(`${pc.cyan('Endpoint:')}  ${config.endpoint}`);
      }
      if (opts.graph) {
        console.log(`${pc.cyan('Graph:')}     ${opts.graph}`);
      }
      if (config.mode === 'embedded') {
        const trackedCount = getTrackedFiles(config, graphUri).length;
        console.log(`${pc.cyan('Tracked files:')} ${trackedCount}`);
      }

      try {
        const adapter = await createReadyAdapter(config);
        const inferenceGraphUri = getInferenceGraphUri(graphUri);
        const assertedCount = await adapter.getGraphTripleCount(graphUri);
        const inferredCount = await adapter.getGraphTripleCount(inferenceGraphUri);
        const totalCount = assertedCount + inferredCount;
        console.log(`${pc.cyan('Triples (asserted):')} ${assertedCount}`);
        console.log(`${pc.cyan('Triples (inferred):')} ${inferredCount}`);
        console.log(`${pc.cyan('Triples (total):')}    ${totalCount}`);
      } catch {
        console.log(
          `${pc.cyan('Triples:')}   Cannot connect to triplestore. Is it running?`
        );
      }
    });
}
