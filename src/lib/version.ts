import { readFileSync } from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getPackageVersion(): string {
  try {
    const packageJsonUrl = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(packageJsonUrl, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Best-effort: fall back below.
  }

  return '0.0.0';
}
