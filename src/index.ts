#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerValidate } from './commands/validate.js';
import { registerPush } from './commands/push.js';
import { registerQuery } from './commands/query.js';
import { registerStatus } from './commands/status.js';
import { registerPull } from './commands/pull.js';
import { registerDrop } from './commands/drop.js';
import { registerDelete } from './commands/delete.js';
import { registerMcp } from './commands/mcp.js';
import { registerShapes } from './commands/shapes.js';
import { registerDiff } from './commands/diff.js';

const program = new Command();
program
  .name('opentology')
  .version('0.1.0')
  .description('CLI-managed RDF/SPARQL infrastructure — Supabase for RDF');

registerInit(program);
registerValidate(program);
registerPush(program);
registerQuery(program);
registerStatus(program);
registerPull(program);
registerDrop(program);
registerDelete(program);
registerMcp(program);
registerShapes(program);
registerDiff(program);

program.parse(process.argv);
