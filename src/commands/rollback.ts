import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, resolveGraphUri } from '../lib/config.js';
import { createReadyAdapter } from '../lib/store-factory.js';
import { listSnapshots, restoreSnapshot } from '../lib/snapshot.js';
import { createInterface } from 'node:readline';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export function registerRollback(program: Command): void {
  program
    .command('rollback')
    .description('List or restore graph snapshots')
    .option('--list', 'List available snapshots')
    .option('--to <timestamp>', 'Restore to a specific snapshot timestamp')
    .option('--graph <name>', 'Target a specific named graph')
    .action(async (opts: { list?: boolean; to?: string; graph?: string }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const graphUri = opts.graph ? resolveGraphUri(config, opts.graph) : config.graphUri;

      if (opts.list) {
        const snapshots = listSnapshots(graphUri);
        if (snapshots.length === 0) {
          console.log(pc.dim('No snapshots found for this graph.'));
          return;
        }
        console.log(pc.bold(`Snapshots for ${graphUri}:`));
        console.log('');
        for (const s of snapshots) {
          const sizeKb = (s.sizeBytes / 1024).toFixed(1);
          const label = s.isPreRollback ? pc.yellow(' (pre-rollback)') : '';
          console.log(`  ${pc.dim(s.timestamp)}  ${sizeKb} KB${label}`);
        }
        return;
      }

      try {
        const adapter = await createReadyAdapter(config);

        if (opts.to) {
          await restoreSnapshot(adapter, config, graphUri, opts.to);
          console.log(pc.green(`Restored graph to snapshot: ${opts.to}`));
          return;
        }

        // No flags: restore latest snapshot with confirmation
        const snapshots = listSnapshots(graphUri).filter((s) => !s.isPreRollback);
        if (snapshots.length === 0) {
          console.log(pc.dim('No snapshots found for this graph.'));
          return;
        }

        const latest = snapshots[0]!;
        const answer = await ask(
          `Restore to latest snapshot ${pc.bold(latest.timestamp)}? [y/N] `
        );

        if (answer === 'y' || answer === 'yes') {
          await restoreSnapshot(adapter, config, graphUri, latest.timestamp);
          console.log(pc.green(`Restored graph to snapshot: ${latest.timestamp}`));
        } else {
          console.log(pc.dim('Rollback cancelled.'));
        }
      } catch (err) {
        console.error(pc.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
