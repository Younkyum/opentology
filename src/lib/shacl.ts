import rdf from 'rdf-ext';
import { Parser } from 'n3';
import { Validator } from 'shacl-engine';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ShaclViolation {
  focusNode: string;
  path: string | null;
  message: string;
  severity: string; // "Violation" | "Warning" | "Info"
}

export interface ShaclReport {
  conforms: boolean;
  violations: ShaclViolation[];
}

/**
 * Discover .ttl shape files in the given directory (defaults to shapes/ in cwd).
 */
export function discoverShapes(dir?: string): string[] {
  const shapesDir = dir ?? join(process.cwd(), 'shapes');
  if (!existsSync(shapesDir)) {
    return [];
  }
  return readdirSync(shapesDir)
    .filter((f) => f.endsWith('.ttl'))
    .map((f) => join(shapesDir, f));
}

/**
 * Check whether the shapes directory exists and contains at least one .ttl file.
 */
export function hasShapes(shapesDir?: string): boolean {
  return discoverShapes(shapesDir).length > 0;
}

/**
 * Parse a Turtle string into an rdf-ext Dataset using n3.
 */
function parseTurtleToDataset(turtle: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parser = new Parser();
    const quads: any[] = [];
    parser.parse(turtle, (err, quad) => {
      if (err) {
        reject(err);
        return;
      }
      if (quad) {
        quads.push(quad);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        resolve(rdf.dataset(quads));
      }
    });
  });
}

/**
 * Load and combine multiple shape .ttl files into a single rdf-ext Dataset.
 */
async function loadShapes(shapePaths: string[]): Promise<any> {
  const allQuads: any[] = [];

  for (const shapePath of shapePaths) {
    const turtle = readFileSync(shapePath, 'utf-8');
    const dataset = await parseTurtleToDataset(turtle);
    for (const quad of dataset) {
      allQuads.push(quad);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  return rdf.dataset(allQuads);
}

/**
 * Extract a string value from a SHACL result message, which may be a Literal object or a plain string.
 */
function extractMessageValue(msg: unknown): string {
  if (!msg) return '';
  if (Array.isArray(msg)) {
    return msg.map(extractMessageValue).join('; ');
  }
  if (typeof msg === 'object' && msg !== null && 'value' in msg) {
    return String((msg as { value: unknown }).value);
  }
  return String(msg);
}

/**
 * Extract the local name from a URI (e.g. "http://...#Violation" → "Violation").
 */
function extractLocalName(uri: string): string {
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx !== -1) return uri.slice(hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  if (slashIdx !== -1) return uri.slice(slashIdx + 1);
  return uri;
}

/**
 * Validate a Turtle data string against the given SHACL shape files.
 */
export async function validateWithShacl(
  dataTurtle: string,
  shapePaths: string[]
): Promise<ShaclReport> {
  const dataDataset = await parseTurtleToDataset(dataTurtle);
  const shapesDataset = await loadShapes(shapePaths);

  const validator = new Validator(shapesDataset, { factory: rdf });
  const report = await validator.validate({ dataset: dataDataset });

  const violations: ShaclViolation[] = (report.results ?? []).map((result: any) => ({
    focusNode: result.focusNode?.value ?? '',
    path: result.path?.value ?? null,
    message: extractMessageValue(result.message),
    severity: extractLocalName(result.severity?.value ?? ''),
  }));

  return {
    conforms: Boolean(report.conforms),
    violations,
  };
}
