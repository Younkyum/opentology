import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, saveConfig, resolveGraphUri } from '../lib/config.js';
import { sparqlQuery, getGraphTripleCount, dropGraph } from '../lib/oxigraph.js';

export function registerGraph(program: Command): void {
  const graph = program
    .command('graph')
    .description('Manage named graphs for the project');

  graph
    .command('list')
    .description('List all named graphs for the project')
    .action(async () => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      try {
        // Query Oxigraph for all graphs that start with the project's base URI
        const results = await sparqlQuery(
          config.endpoint,
          `SELECT DISTINCT ?g (COUNT(*) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g`
        );

        const baseUri = config.graphUri;
        const remoteGraphs = new Map<string, number>();
        for (const binding of results.results.bindings) {
          const g = binding['g']?.value;
          const count = binding['count']?.value;
          if (g && g.startsWith(baseUri)) {
            remoteGraphs.set(g, count ? parseInt(count, 10) : 0);
          }
        }

        // Merge with config.graphs
        const configGraphs = config.graphs ?? {};
        const allUris = new Set<string>([
          baseUri,
          ...remoteGraphs.keys(),
          ...Object.values(configGraphs),
        ]);

        // Build name lookup: URI -> logical name
        const uriToName = new Map<string, string>();
        uriToName.set(baseUri, '(default)');
        for (const [name, uri] of Object.entries(configGraphs)) {
          uriToName.set(uri, name);
        }

        // Print table
        console.log(
          `${'Name'.padEnd(20)}  ${'URI'.padEnd(60)}  ${'Triples'.padStart(8)}`
        );
        console.log(`${'-'.repeat(20)}  ${'-'.repeat(60)}  ${'-'.repeat(8)}`);

        for (const uri of allUris) {
          const name = uriToName.get(uri) ?? '?';
          const count = remoteGraphs.get(uri);
          const tripleStr = count !== undefined ? String(count) : '?';
          console.log(
            `${name.padEnd(20)}  ${uri.padEnd(60)}  ${tripleStr.padStart(8)}`
          );
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

  graph
    .command('create <name>')
    .description('Create a new named graph')
    .action(async (name: string) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphs = config.graphs ?? {};
      if (graphs[name]) {
        console.error(`Graph '${name}' already exists: ${graphs[name]}`);
        process.exit(1);
      }

      const uri = `${config.graphUri}/${name}`;
      graphs[name] = uri;
      config.graphs = graphs;
      saveConfig(config);

      console.log(pc.green(`Created graph '${name}' -> ${uri}`));
    });

  graph
    .command('drop <name>')
    .description('Drop a named graph')
    .option('--force', 'Skip confirmation and drop immediately')
    .action(async (name: string, opts: { force?: boolean }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      let graphUri: string;
      try {
        graphUri = resolveGraphUri(config, name);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
        return;
      }

      if (!opts.force) {
        console.error(
          pc.red(`This will delete all triples in graph '${name}' (${graphUri}). Use --force to confirm.`)
        );
        process.exit(1);
      }

      try {
        await dropGraph(config.endpoint, graphUri);

        const graphs = config.graphs ?? {};
        delete graphs[name];
        config.graphs = Object.keys(graphs).length > 0 ? graphs : undefined;
        saveConfig(config);

        console.log(pc.green(`Dropped graph '${name}' (${graphUri})`));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
