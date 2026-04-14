import { Command } from 'commander';
import { handleContextScan } from '../mcp/server.js';

export function registerContext(program: Command): void {
  const ctx = program.command('context').description('Context management commands');

  ctx
    .command('scan')
    .description('Scan the codebase and update the knowledge graph')
    .option('--depth <depth>', 'Scan depth: "module" or "symbol"', 'symbol')
    .option('--incremental', 'Only scan files changed since the last scan', false)
    .option('--max-files <n>', 'Maximum files to scan (symbol depth)', parseInt)
    .option('--max-symbols <n>', 'Maximum symbols to extract (symbol depth)', parseInt)
    .option('--timeout <ms>', 'Timeout in milliseconds (symbol depth)', parseInt)
    .action(async (opts: {
      depth: string;
      incremental: boolean;
      maxFiles?: number;
      maxSymbols?: number;
      timeout?: number;
    }) => {
      try {
        const result = await handleContextScan({
          depth: opts.depth,
          incremental: opts.incremental,
          maxFiles: opts.maxFiles,
          maxSymbols: opts.maxSymbols,
          timeoutMs: opts.timeout,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`context scan failed: ${msg}`);
        process.exit(1);
      }
    });
}
