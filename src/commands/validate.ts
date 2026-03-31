import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { validateTurtleFile } from '../lib/validator.js';
import { discoverShapes, validateWithShacl } from '../lib/shacl.js';

export function registerValidate(program: Command): void {
  program
    .command('validate <file>')
    .description('Validate a local Turtle/RDF file')
    .option('--shacl', 'Also validate against SHACL shapes in shapes/ directory')
    .action(async (file: string, opts: { shacl?: boolean }) => {
      try {
        const result = await validateTurtleFile(file);

        if (result.valid) {
          const prefixList = Object.keys(result.prefixes).join(', ') || '(none)';
          console.log(pc.green(`Valid — ${result.tripleCount} triples, prefixes: ${prefixList}`));
        } else {
          console.error(pc.red(`Validation failed: ${result.error}`));
          process.exit(1);
        }

        if (opts.shacl) {
          const shapePaths = discoverShapes();
          if (shapePaths.length === 0) {
            console.log('SHACL: no shapes found in shapes/ directory');
          } else {
            const content = readFileSync(file, 'utf-8');
            const report = await validateWithShacl(content, shapePaths);
            if (report.conforms) {
              console.log(pc.green('SHACL: conforms'));
            } else {
              for (const v of report.violations) {
                console.error(pc.yellow(`SHACL Violation: ${v.focusNode} — ${v.message} (path: ${v.path})`));
              }
              process.exit(1);
            }
          }
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
