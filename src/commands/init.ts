import { Command } from 'commander';
import { basename } from 'node:path';
import pc from 'picocolors';
import { configExists, saveConfig } from '../lib/config.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function registerInit(program: Command): void {
  program
    .command('init [projectId]')
    .description('Initialize a new OpenTology project')
    .option('--embedded', 'Use embedded mode (no server needed)')
    .action((projectId: string | undefined, opts: { embedded?: boolean }) => {
      if (configExists()) {
        console.error('Error: .opentology.json already exists in this directory.');
        console.error('Remove it first if you want to re-initialize.');
        process.exit(1);
      }

      const id = projectId || slugify(basename(process.cwd()));
      if (!id) {
        console.error('Error: Could not determine project ID. Please provide one explicitly.');
        process.exit(1);
      }

      const graphUri = `https://opentology.dev/${id}`;

      if (opts.embedded) {
        saveConfig({ projectId: id, mode: 'embedded', graphUri });

        console.log(pc.green(`Initialized OpenTology project.`));
        console.log(`  Project ID: ${id}`);
        console.log(`  Mode:       embedded (no server needed)`);
        console.log(`  Graph URI:  ${graphUri}`);
        console.log(`\nConfig saved to .opentology.json`);
      } else {
        const endpoint = 'http://localhost:7878';
        saveConfig({ projectId: id, mode: 'http', endpoint, graphUri });

        console.log(pc.green(`Initialized OpenTology project.`));
        console.log(`  Project ID: ${id}`);
        console.log(`  Mode:       http`);
        console.log(`  Endpoint:   ${endpoint}`);
        console.log(`  Graph URI:  ${graphUri}`);
        console.log(`\nConfig saved to .opentology.json`);
      }
    });
}
