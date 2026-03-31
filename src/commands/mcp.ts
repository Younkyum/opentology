import { Command } from 'commander';
import { startMcpServer } from '../mcp/server.js';

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('Start MCP server for AI agent integration')
    .action(async () => {
      await startMcpServer();
    });
}
