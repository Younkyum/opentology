import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path, { join } from 'node:path';

export interface OpenTologyConfig {
  projectId: string;
  mode: 'http' | 'embedded';
  endpoint?: string;
  graphUri: string;
  graphs?: Record<string, string>;
  files?: Record<string, string[]>;
  prefixes?: Record<string, string>;
}

export function resolveGraphUri(config: OpenTologyConfig, graphName?: string): string {
  if (!graphName) {
    return config.graphUri;
  }
  const uri = config.graphs?.[graphName];
  if (!uri) {
    throw new Error(`Unknown graph: ${graphName}. Use 'opentology graph create ${graphName}' first.`);
  }
  return uri;
}

const CONFIG_FILENAME = '.opentology.json';

function configPath(): string {
  return join(process.cwd(), CONFIG_FILENAME);
}

export function loadConfig(): OpenTologyConfig {
  const configFilePath = configPath();
  if (!existsSync(configFilePath)) {
    throw new Error(
      `Config file not found at ${configFilePath}. Run 'opentology init' first.`
    );
  }
  try {
    const raw = readFileSync(configFilePath, 'utf-8');
    const config = JSON.parse(raw) as OpenTologyConfig;
    if (!config.mode) {
      config.mode = 'http';
    }
    if (config.mode === 'http' && !config.endpoint) {
      config.endpoint = 'http://localhost:7878';
    }
    return config;
  } catch (err) {
    throw new Error(
      `Failed to read config file at ${configFilePath}: ${(err as Error).message}`
    );
  }
}

export function saveConfig(config: OpenTologyConfig): void {
  const configFilePath = configPath();
  try {
    writeFileSync(configFilePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to write config file at ${configFilePath}: ${(err as Error).message}`
    );
  }
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export function resolveEndpoint(config: OpenTologyConfig): string {
  if (config.endpoint) return config.endpoint;
  if (config.mode === 'embedded') {
    throw new Error("No endpoint configured: project is in 'embedded' mode.");
  }
  return 'http://localhost:7878';
}

export function getTrackedFiles(config: OpenTologyConfig, graphUri: string): string[] {
  return config.files?.[graphUri] ?? [];
}

export function addTrackedFile(config: OpenTologyConfig, graphUri: string, filePath: string): void {
  if (!config.files) config.files = {};
  if (!config.files[graphUri]) config.files[graphUri] = [];
  // Store relative path
  const relative = path.relative(process.cwd(), path.resolve(filePath));
  if (!config.files[graphUri].includes(relative)) {
    config.files[graphUri].push(relative);
  }
}
