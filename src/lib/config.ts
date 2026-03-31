import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface OpenTologyConfig {
  projectId: string;
  endpoint: string;
  graphUri: string;
}

const CONFIG_FILENAME = '.opentology.json';

function configPath(): string {
  return join(process.cwd(), CONFIG_FILENAME);
}

export function loadConfig(): OpenTologyConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(
      `Config file not found at ${path}. Run 'opentology init' first.`
    );
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as OpenTologyConfig;
  } catch (err) {
    throw new Error(
      `Failed to read config file at ${path}: ${(err as Error).message}`
    );
  }
}

export function saveConfig(config: OpenTologyConfig): void {
  const path = configPath();
  try {
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to write config file at ${path}: ${(err as Error).message}`
    );
  }
}

export function configExists(): boolean {
  return existsSync(configPath());
}
