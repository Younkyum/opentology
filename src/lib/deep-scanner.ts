/**
 * Deep scanner — language-agnostic orchestrator for symbol-level codebase analysis.
 * Delegates to LanguageExtractor implementations (ts-morph, tree-sitter, etc.).
 */

import type { LanguageExtractor } from './language-extractor.js';
import { TypeScriptExtractor } from './deep-scanner-ts.js';
import { PythonExtractor } from './extractors/python.js';
import { GoExtractor } from './extractors/go.js';
import { RustExtractor } from './extractors/rust.js';
import { JavaExtractor } from './extractors/java.js';
import { SwiftExtractor } from './extractors/swift.js';

// ── Exported types ──────────────────────────────────────────────

export interface DeepScanOptions {
  maxFiles?: number;            // default 500
  maxSymbols?: number;          // default 300
  timeoutMs?: number;           // default 30_000
  includeMethodCalls?: boolean; // default false
  languages?: string[];         // e.g. ['typescript', 'python'] — auto-detect if omitted
}

export interface MethodInfo {
  name: string;
  returnType: string;
  parameters: Array<{ name: string; type: string }>;
}

export interface ClassInfo {
  name: string;
  filePath: string;
  baseClass: string | null;
  interfaces: string[];
  methods: MethodInfo[];
  isAbstract: boolean;
}

export interface InterfaceInfo {
  name: string;
  filePath: string;
  extends: string[];
  methods: Array<{ name: string; returnType: string }>;
}

export interface FunctionInfo {
  name: string;
  filePath: string;
  returnType: string;
  parameters: Array<{ name: string; type: string }>;
  isExported: boolean;
}

export interface MethodCallInfo {
  caller: string;  // ClassName.methodName
  callee: string;  // ClassName.methodName
}

export interface UnsupportedFileGroup {
  extension: string;
  language: string;
  files: string[];
  count: number;
}

export interface DeepScanResult {
  deepScanAvailable: true;
  classes: ClassInfo[];
  interfaces: InterfaceInfo[];
  functions: FunctionInfo[];
  methodCalls: MethodCallInfo[];
  unsupportedFiles: UnsupportedFileGroup[];
  fileCount: number;
  symbolCount: number;
  scanDurationMs: number;
  capped: boolean;
  warnings: string[];
}

export interface DeepScanUnavailable {
  deepScanAvailable: false;
  error: string;
  fallback: null;
}

export type DeepScanOutput = DeepScanResult | DeepScanUnavailable;

// ── Extractor registry ─────────────────────────────────────────

/** All known extractors. Add new languages here. */
function getAllExtractors(): LanguageExtractor[] {
  return [
    new TypeScriptExtractor(),
    new PythonExtractor(),
    new GoExtractor(),
    new RustExtractor(),
    new JavaExtractor(),
    new SwiftExtractor(),
  ];
}

function detectLanguages(rootDir: string, extractors: LanguageExtractor[]): LanguageExtractor[] {
  // For now, return all available extractors.
  // Future: scan rootDir for file extensions and filter.
  return extractors;
}

// ── File discovery ─────────────────────────────────────────────

async function discoverFiles(
  rootDir: string,
  extensions: string[],
  maxFiles: number,
): Promise<{ files: string[]; total: number }> {
  const { execSync } = await import('node:child_process');

  // Use git ls-files if inside a git repo, otherwise fall back to find
  const extGlob = extensions.map(e => `*${e}`);
  let stdout: string;
  try {
    stdout = execSync(
      `git -C "${rootDir}" ls-files -- ${extGlob.map(g => `'${g}'`).join(' ')}`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    // Not a git repo — fall back
    const patterns = extensions.map(e => `-name '*${e}'`).join(' -o ');
    stdout = execSync(
      `find "${rootDir}" -type f \\( ${patterns} \\) -not -path '*/node_modules/*' -not -path '*/dist/*'`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
  }

  const allFiles = stdout.trim().split('\n').filter(Boolean)
    .filter(f => !f.includes('node_modules') && !f.includes('/dist/'));
  return { files: allFiles.slice(0, maxFiles), total: allFiles.length };
}

// ── Unsupported language detection ─────────────────────────────

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.rb': 'ruby', '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c', '.h': 'c-header', '.hpp': 'cpp-header',
  '.php': 'php', '.lua': 'lua', '.dart': 'dart',
  '.scala': 'scala', '.ex': 'elixir', '.exs': 'elixir',
  '.zig': 'zig', '.jl': 'julia', '.r': 'r',
  '.clj': 'clojure', '.erl': 'erlang', '.hs': 'haskell',
  '.ml': 'ocaml', '.nim': 'nim', '.cr': 'crystal',
  '.pl': 'perl', '.pm': 'perl',
};

const SKIP_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
  '.md', '.txt', '.rst', '.csv', '.tsv', '.adoc',
  '.css', '.scss', '.less', '.sass', '.styl',
  '.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lock', '.log', '.map', '.d.ts',
  '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib', '.a',
  '.env', '.gitignore', '.gitattributes', '.editorconfig',
  '.prettierrc', '.eslintrc', '.babelrc',
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
]);

async function discoverUnsupportedFiles(
  rootDir: string,
  supportedExtensions: Set<string>,
): Promise<UnsupportedFileGroup[]> {
  const { execSync } = await import('node:child_process');
  const { extname } = await import('node:path');

  let stdout: string;
  try {
    stdout = execSync(`git -C "${rootDir}" ls-files`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const allFiles = stdout.trim().split('\n').filter(Boolean)
    .filter(f => !f.includes('node_modules') && !f.includes('/dist/'));

  const groups = new Map<string, string[]>();
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!ext || supportedExtensions.has(ext) || SKIP_EXTENSIONS.has(ext)) continue;
    if (!EXTENSION_LANGUAGE_MAP[ext]) continue; // only known source languages
    if (!groups.has(ext)) groups.set(ext, []);
    groups.get(ext)!.push(file);
  }

  return Array.from(groups.entries())
    .map(([ext, files]) => ({
      extension: ext,
      language: EXTENSION_LANGUAGE_MAP[ext] ?? ext.slice(1),
      files,
      count: files.length,
    }))
    .filter(g => g.count > 0)
    .sort((a, b) => b.count - a.count);
}

// ── Main entry point ────────────────────────────────────────────

export async function deepScan(
  rootDir: string,
  options?: DeepScanOptions,
): Promise<DeepScanOutput> {
  const maxFiles = options?.maxFiles ?? 500;
  const maxSymbols = options?.maxSymbols ?? 300;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const includeMethodCalls = options?.includeMethodCalls ?? false;
  const requestedLanguages = options?.languages;

  const start = Date.now();

  // Resolve extractors
  let allExtractors = getAllExtractors();
  if (requestedLanguages) {
    allExtractors = allExtractors.filter(e => requestedLanguages.includes(e.language));
  }

  // Check availability
  const available: LanguageExtractor[] = [];
  for (const ext of allExtractors) {
    if (await ext.isAvailable()) {
      available.push(ext);
    }
  }

  if (available.length === 0) {
    return {
      deepScanAvailable: false,
      error: requestedLanguages
        ? `No extractors available for: ${requestedLanguages.join(', ')}. Install required dependencies.`
        : 'No language extractors available. Install ts-morph for TypeScript support.',
      fallback: null,
    };
  }

  // Collect all extensions from available extractors
  const allExtensions = available.flatMap(e => e.extensions);

  // Discover files
  const { files, total } = await discoverFiles(rootDir, allExtensions, maxFiles);

  if (total > maxFiles) {
    return {
      deepScanAvailable: true,
      classes: [],
      interfaces: [],
      functions: [],
      methodCalls: [],
      unsupportedFiles: [],
      fileCount: total,
      symbolCount: 0,
      scanDurationMs: Date.now() - start,
      capped: true,
      warnings: [`File count ${total} exceeds maxFiles ${maxFiles}. Scan skipped.`],
    };
  }

  // Group files by extractor
  const filesByExtractor = new Map<LanguageExtractor, string[]>();
  for (const ext of available) {
    filesByExtractor.set(ext, []);
  }
  for (const file of files) {
    for (const ext of available) {
      if (ext.extensions.some(e => file.endsWith(e))) {
        filesByExtractor.get(ext)!.push(file);
        break;
      }
    }
  }

  // Run extractors
  const classes: ClassInfo[] = [];
  const interfaces: InterfaceInfo[] = [];
  const functions: FunctionInfo[] = [];
  const methodCalls: MethodCallInfo[] = [];
  const warnings: string[] = [];
  let capped = false;

  for (const [extractor, extFiles] of filesByExtractor) {
    if (extFiles.length === 0) continue;
    if (capped) break;

    const remainingTime = timeoutMs - (Date.now() - start);
    if (remainingTime <= 0) {
      capped = true;
      warnings.push(`Timeout before running ${extractor.language} extractor.`);
      break;
    }

    const result = await extractor.extract(extFiles, rootDir, {
      maxSymbols,
      timeoutMs: remainingTime,
      includeMethodCalls,
    });

    // If the only extractor reports a fatal error, propagate as unavailable
    if (result.fatal && available.length === 1) {
      return {
        deepScanAvailable: false,
        error: result.fatal,
        fallback: null,
      };
    }

    classes.push(...result.classes);
    interfaces.push(...result.interfaces);
    functions.push(...result.functions);
    methodCalls.push(...result.methodCalls);
    warnings.push(...result.warnings);
    if (result.fatal) warnings.push(`${extractor.language}: ${result.fatal}`);
    if (result.capped) capped = true;
  }

  const symbolCount = classes.reduce((n, c) => n + 1 + c.methods.length, 0)
    + interfaces.length
    + functions.length;

  // Discover unsupported language files
  const supportedExtensions = new Set(available.flatMap(e => e.extensions));
  const unsupportedFiles = await discoverUnsupportedFiles(rootDir, supportedExtensions);

  return {
    deepScanAvailable: true,
    classes,
    interfaces,
    functions,
    methodCalls,
    unsupportedFiles,
    fileCount: files.length,
    symbolCount,
    scanDurationMs: Date.now() - start,
    capped,
    warnings,
  };
}
