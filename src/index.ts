#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerQuery } from './commands/query.js';
import { registerMcp } from './commands/mcp.js';
import { registerContext } from './commands/context.js';

const program = new Command();
program
  .name('opentology')
  .version('0.2.4')
  .description('CLI-managed RDF/SPARQL infrastructure — Supabase for RDF');

registerInit(program);
registerQuery(program);
registerMcp(program);
registerContext(program);

program.parse(process.argv);
