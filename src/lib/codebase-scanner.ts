import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DirectoryNode {
  name: string;
  type: 'file' | 'directory';
  children?: DirectoryNode[];
}

export interface CodebaseSnapshot {
  packageJson: {
    name?: string;
    version?: string;
    description?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  } | null;
  tsconfig: {
    target?: string;
    module?: string;
    strict?: boolean;
    paths?: Record<string, string[]>;
  } | null;
  directoryTree: DirectoryNode[];
  entryPoints: Array<{
    path: string;
    content: string;
  }>;
  detectedImports: string[];
  readme: string | null;
  truncated?: boolean;
}

const DEFAULT_MAX_BYTES = 15360;
const HARDCODED_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'build', '.opentology', '.claude', '.omc']);
const MAX_ENTRY_POINT_LINES = 150;
const MAX_README_LINES = 100;

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function getGitTrackedFiles(rootDir: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: rootDir });
    const files = new Set<string>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
    return files;
  } catch {
    return null;
  }
}

function isExcluded(name: string, gitFiles: Set<string> | null, relativePath: string): boolean {
  if (HARDCODED_EXCLUDES.has(name)) return true;
  if (gitFiles !== null) {
    // Check if any git-tracked file starts with this path
    for (const f of gitFiles) {
      if (f === relativePath || f.startsWith(relativePath + '/')) return false;
    }
    return true;
  }
  return false;
}

async function buildDirectoryTree(
  rootDir: string,
  currentDir: string,
  gitFiles: Set<string> | null,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<DirectoryNode[]> {
  if (currentDepth >= maxDepth) return [];

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: DirectoryNode[] = [];
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    const relPath = relative(rootDir, join(currentDir, entry.name));
    if (isExcluded(entry.name, gitFiles, relPath)) continue;

    if (entry.isDirectory()) {
      const children = await buildDirectoryTree(rootDir, join(currentDir, entry.name), gitFiles, maxDepth, currentDepth + 1);
      nodes.push({ name: entry.name, type: 'directory', children });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, type: 'file' });
    }
  }
  return nodes;
}

async function readTruncatedFile(filePath: string, maxLines: number): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
    }
    return content;
  } catch {
    return null;
  }
}

function detectEntryPoints(pkg: Record<string, unknown>): string[] {
  const entries: string[] = [];
  if (typeof pkg.main === 'string') entries.push(pkg.main);
  if (typeof pkg.bin === 'string') {
    entries.push(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    entries.push(...Object.values(pkg.bin as Record<string, string>));
  }
  if (pkg.exports && typeof pkg.exports === 'object') {
    const walk = (obj: unknown): void => {
      if (typeof obj === 'string') { entries.push(obj); return; }
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj as Record<string, unknown>)) walk(v);
      }
    };
    walk(pkg.exports);
  }
  // Deduplicate and resolve dist→src mapping for TS projects
  const seen = new Set<string>();
  const result: string[] = [];
  for (const e of entries) {
    const normalized = e.replace(/^\.\//, '');
    // Try source version first (dist/index.js → src/index.ts)
    const srcVersion = normalized.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    if (!seen.has(srcVersion)) {
      seen.add(srcVersion);
      result.push(srcVersion);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

async function detectImports(rootDir: string, filePaths: string[]): Promise<string[]> {
  const imports = new Set<string>();

  // Also scan up to 5 src/*.ts files
  const scanPaths = [...filePaths];
  try {
    const srcEntries = await readdir(join(rootDir, 'src'), { withFileTypes: true });
    let count = 0;
    for (const e of srcEntries) {
      if (count >= 5) break;
      if (e.isFile() && e.name.endsWith('.ts')) {
        const p = `src/${e.name}`;
        if (!scanPaths.includes(p)) {
          scanPaths.push(p);
          count++;
        }
      }
    }
  } catch { /* no src dir */ }

  for (const fp of scanPaths) {
    try {
      const content = await readFile(join(rootDir, fp), 'utf-8');
      const importRegex = /(?:import|from)\s+['"]([^./'][^'"]*)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const pkg = match[1];
        // Extract package name (handle scoped packages)
        if (pkg.startsWith('@')) {
          const parts = pkg.split('/');
          if (parts.length >= 2) imports.add(`${parts[0]}/${parts[1]}`);
        } else {
          imports.add(pkg.split('/')[0]);
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return [...imports].sort();
}

function byteLength(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf-8');
}

function applyTruncation(snapshot: CodebaseSnapshot, maxBytes: number): CodebaseSnapshot {
  // Stage 1: Shorten entry point contents
  if (byteLength(snapshot) > maxBytes) {
    snapshot.entryPoints = snapshot.entryPoints.map(ep => ({
      path: ep.path,
      content: ep.content.split('\n').slice(0, 50).join('\n') + '\n... (truncated)',
    }));
    snapshot.truncated = true;
  }

  // Stage 2: Trim README
  if (byteLength(snapshot) > maxBytes && snapshot.readme) {
    const lines = snapshot.readme.split('\n');
    snapshot.readme = lines.slice(0, 30).join('\n') + '\n... (truncated)';
    snapshot.truncated = true;
  }

  // Stage 3: Reduce tree depth to 2
  if (byteLength(snapshot) > maxBytes) {
    const pruneDepth = (nodes: DirectoryNode[], depth: number): DirectoryNode[] => {
      return nodes.map(n => {
        if (n.type === 'directory' && n.children) {
          if (depth >= 1) return { name: n.name, type: n.type as 'directory' };
          return { ...n, children: pruneDepth(n.children, depth + 1) };
        }
        return n;
      });
    };
    snapshot.directoryTree = pruneDepth(snapshot.directoryTree, 0);
    snapshot.truncated = true;
  }

  // Stage 4: Drop detectedImports
  if (byteLength(snapshot) > maxBytes) {
    snapshot.detectedImports = [];
    snapshot.truncated = true;
  }

  return snapshot;
}

export async function scanCodebase(rootDir: string, maxBytes: number = DEFAULT_MAX_BYTES): Promise<CodebaseSnapshot> {
  // Read package.json
  const rawPkg = await readJsonFile(join(rootDir, 'package.json')) as Record<string, unknown> | null;
  const packageJson = rawPkg ? {
    name: rawPkg.name as string | undefined,
    version: rawPkg.version as string | undefined,
    description: rawPkg.description as string | undefined,
    scripts: rawPkg.scripts as Record<string, string> | undefined,
    dependencies: rawPkg.dependencies as Record<string, string> | undefined,
    devDependencies: rawPkg.devDependencies as Record<string, string> | undefined,
    engines: rawPkg.engines as Record<string, string> | undefined,
  } : null;

  // Read tsconfig.json or jsconfig.json
  let rawTsConfig = await readJsonFile(join(rootDir, 'tsconfig.json')) as Record<string, unknown> | null;
  if (!rawTsConfig) {
    rawTsConfig = await readJsonFile(join(rootDir, 'jsconfig.json')) as Record<string, unknown> | null;
  }
  const compilerOptions = rawTsConfig?.compilerOptions as Record<string, unknown> | undefined;
  const tsconfig = rawTsConfig ? {
    target: compilerOptions?.target as string | undefined,
    module: compilerOptions?.module as string | undefined,
    strict: compilerOptions?.strict as boolean | undefined,
    paths: compilerOptions?.paths as Record<string, string[]> | undefined,
  } : null;

  // Get git-tracked files for gitignore awareness
  const gitFiles = await getGitTrackedFiles(rootDir);

  // Build directory tree (depth 3)
  const directoryTree = await buildDirectoryTree(rootDir, rootDir, gitFiles, 3);

  // Detect and read entry points
  const entryPointPaths = rawPkg ? detectEntryPoints(rawPkg) : [];
  const entryPoints: Array<{ path: string; content: string }> = [];
  for (const ep of entryPointPaths) {
    const content = await readTruncatedFile(join(rootDir, ep), MAX_ENTRY_POINT_LINES);
    if (content !== null) {
      entryPoints.push({ path: ep, content });
    }
  }

  // Detect imports
  const detectedImports = await detectImports(rootDir, entryPointPaths);

  // Read README
  const readme = await readTruncatedFile(join(rootDir, 'README.md'), MAX_README_LINES);

  let snapshot: CodebaseSnapshot = {
    packageJson,
    tsconfig,
    directoryTree,
    entryPoints,
    detectedImports,
    readme,
  };

  // Apply byte cap with progressive truncation
  if (byteLength(snapshot) > maxBytes) {
    snapshot = applyTruncation(snapshot, maxBytes);
  }

  return snapshot;
}
