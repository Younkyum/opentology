import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerQuery } from './commands/query.js';
import { registerMcp } from './commands/mcp.js';
import { getPackageVersion } from './lib/version.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('opentology')
    .version(getPackageVersion())
    .description('CLI-managed RDF/SPARQL infrastructure — Supabase for RDF');

  registerInit(program);
  registerQuery(program);
  registerMcp(program);

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = createProgram();
  program.parse(argv);
}
