import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, saveConfig } from '../lib/config.js';

export function registerPrefix(program: Command): void {
  const prefix = program
    .command('prefix')
    .description('Manage project-level SPARQL prefix declarations');

  prefix
    .command('list')
    .description('Show all registered prefixes')
    .action(() => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const prefixes = config.prefixes ?? {};
      const entries = Object.entries(prefixes);

      if (entries.length === 0) {
        console.log('No prefixes registered. Use `opentology prefix add <name> <uri>` to add one.');
        return;
      }

      const maxName = Math.max(...entries.map(([n]) => n.length), 6);
      console.log(`${'PREFIX'.padEnd(maxName)}  URI`);
      console.log(`${'-'.repeat(maxName)}  ${'-'.repeat(40)}`);
      for (const [name, uri] of entries) {
        console.log(`${pc.cyan(name.padEnd(maxName))}  ${uri}`);
      }
    });

  prefix
    .command('add <name> <uri>')
    .description('Add a prefix mapping')
    .action((name: string, uri: string) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      if (!config.prefixes) config.prefixes = {};
      config.prefixes[name] = uri;
      saveConfig(config);
      console.log(pc.green(`Added prefix ${pc.cyan(name)}: → ${uri}`));
    });

  prefix
    .command('remove <name>')
    .description('Remove a prefix mapping')
    .action((name: string) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      if (!config.prefixes?.[name]) {
        console.error(`Error: prefix '${name}' is not registered.`);
        process.exit(1);
      }

      delete config.prefixes[name];
      if (Object.keys(config.prefixes).length === 0) {
        config.prefixes = undefined;
      }
      saveConfig(config);
      console.log(pc.green(`Removed prefix ${pc.cyan(name)}`));
    });
}
