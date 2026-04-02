import { Command } from 'commander';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import { fromSchemaData, toMermaid, toDot } from '../lib/visualizer.js';
import { writeFileSync } from 'fs';

export function registerViz(program: Command): void {
  const viz = program
    .command('viz')
    .description('Visualize graph data as Mermaid or DOT diagrams');

  viz
    .command('schema')
    .description('Visualize the ontology schema (classes, properties, relationships)')
    .option('--format <type>', 'Output format: mermaid, dot', 'mermaid')
    .option('--output <file>', 'Write output to file instead of stdout')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (options: { format?: string; output?: string; graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = options.graph ? resolveGraphUri(config, options.graph) : config.graphUri;
      const format = options.format || 'mermaid';

      if (format !== 'mermaid' && format !== 'dot') {
        console.error(`Error: unsupported format "${format}". Use "mermaid" or "dot".`);
        process.exit(1);
      }

      try {
        const adapter = await createReadyAdapter(config);
        const overview = await adapter.getSchemaOverview(graphUri);
        const relations = await adapter.getSchemaRelations(graphUri);
        const visGraph = fromSchemaData(overview, relations);

        const output = format === 'dot' ? toDot(visGraph) : toMermaid(visGraph);

        if (options.output) {
          writeFileSync(options.output, output, 'utf-8');
          console.log(`Written to ${options.output}`);
        } else {
          console.log(output);
        }
      } catch (err) {
        const message = (err as Error).message;
        console.error(`Error: ${message}`);
        if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
          console.error(
            `Cannot connect to triplestore at ${config.endpoint ?? 'unknown'}. Is it running?`,
          );
        }
        process.exit(1);
      }
    });
}
