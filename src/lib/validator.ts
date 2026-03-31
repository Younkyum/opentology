import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import type { Quad } from 'n3';

export type ValidationResult =
  | { valid: true; tripleCount: number; prefixes: Record<string, string> }
  | { valid: false; error: string };

export async function validateTurtle(content: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const parser = new Parser();
    const quads: Quad[] = [];
    const prefixes: Record<string, string> = {};

    parser.parse(content, (err, quad, prefixMap) => {
      if (err) {
        resolve({ valid: false, error: err.message });
        return;
      }

      if (quad) {
        quads.push(quad);
      } else {
        // Done — prefixMap is provided as the third argument on completion
        if (prefixMap) {
          for (const [prefix, iri] of Object.entries(prefixMap)) {
            prefixes[prefix] = (iri as { value?: string }).value ?? String(iri);
          }
        }
        resolve({ valid: true, tripleCount: quads.length, prefixes });
      }
    });
  });
}

export async function validateTurtleFile(filePath: string): Promise<ValidationResult> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      valid: false,
      error: `Could not read file '${filePath}': ${(err as Error).message}`,
    };
  }

  return validateTurtle(content);
}
