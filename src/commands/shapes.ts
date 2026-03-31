import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Parser } from 'n3';
import { discoverShapes } from '../lib/shacl.js';

/**
 * Parse a Turtle file and extract sh:targetClass values.
 */
function extractTargetClasses(turtle: string): string[] {
  const classes: string[] = [];
  const parser = new Parser();
  const quads = parser.parse(turtle);
  for (const quad of quads) {
    if (
      quad.predicate.value === 'http://www.w3.org/ns/shacl#targetClass'
    ) {
      classes.push(quad.object.value);
    }
  }
  return classes;
}

export function registerShapes(program: Command): void {
  const shapes = program
    .command('shapes')
    .description('List and inspect SHACL shapes');

  shapes
    .command('list', { isDefault: true })
    .description('List all shapes in shapes/ directory')
    .action(() => {
      const shapePaths = discoverShapes();
      if (shapePaths.length === 0) {
        console.log('No shapes found in shapes/ directory');
        return;
      }

      console.log('Shapes:');
      console.log('');
      console.log(padRight('File', 30) + padRight('Target Classes', 50));
      console.log(padRight('—', 30, '—') + padRight('—', 50, '—'));

      for (const shapePath of shapePaths) {
        const name = basename(shapePath);
        try {
          const content = readFileSync(shapePath, 'utf-8');
          const targets = extractTargetClasses(content);
          const targetStr = targets.length > 0 ? targets.join(', ') : '(none)';
          console.log(padRight(name, 30) + padRight(targetStr, 50));
        } catch {
          console.log(padRight(name, 30) + padRight('(parse error)', 50));
        }
      }
    });

  shapes
    .command('show <file>')
    .description('Display a shape file\'s contents')
    .action((file: string) => {
      const shapePaths = discoverShapes();
      const match = shapePaths.find((p) => basename(p) === file || p === file);
      if (!match) {
        console.error(`Shape file not found: ${file}`);
        process.exit(1);
      }
      const content = readFileSync(match, 'utf-8');
      console.log(content);
    });
}

function padRight(str: string, len: number, fill = ' '): string {
  if (str.length >= len) return str;
  return str + fill.repeat(len - str.length);
}
