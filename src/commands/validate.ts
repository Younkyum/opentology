import { Command } from 'commander';
import { validateTurtleFile } from '../lib/validator.js';

export function registerValidate(program: Command): void {
  program
    .command('validate <file>')
    .description('Validate a local Turtle/RDF file')
    .action(async (file: string) => {
      try {
        const result = await validateTurtleFile(file);

        if (result.valid) {
          const prefixList = Object.keys(result.prefixes).join(', ') || '(none)';
          console.log(`Valid — ${result.tripleCount} triples, prefixes: ${prefixList}`);
        } else {
          console.error(`Validation failed: ${result.error}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
