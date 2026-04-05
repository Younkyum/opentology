/**
 * Tree-sitter base extractor — abstract class that handles WASM loading,
 * parser initialization, and provides query helpers for language-specific extractors.
 *
 * web-tree-sitter and tree-sitter-wasms are optional peerDependencies.
 */

import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from './deep-scanner.js';
import type { LanguageExtractor, ExtractedSymbols } from './language-extractor.js';

// Re-export tree-sitter types for subclass use
// In web-tree-sitter@0.24.x, types live under the Parser namespace
type TSParser = import('web-tree-sitter');
type TSLanguage = import('web-tree-sitter').Language;
type TSTree = import('web-tree-sitter').Tree;
type TSNode = import('web-tree-sitter').SyntaxNode;

export type { TSNode, TSTree, TSLanguage };

// ── WASM loading cache ──────────────────────────────────────────

let parserClass: (new () => TSParser) | null = null;
let languageClass: { load(input: string | Uint8Array): Promise<TSLanguage> } | null = null;
let initialized = false;
const languageCache = new Map<string, TSLanguage>();

async function initTreeSitter(): Promise<boolean> {
  if (initialized) return parserClass !== null;
  try {
    const mod = await import('web-tree-sitter');
    const Parser = mod.default ?? mod;
    await (Parser as any).init();
    parserClass = Parser as unknown as new () => TSParser;
    languageClass = (Parser as any).Language ?? mod.Language;
    initialized = true;
    return true;
  } catch {
    initialized = true;
    return false;
  }
}

async function loadLanguage(wasmName: string): Promise<TSLanguage | null> {
  if (languageCache.has(wasmName)) return languageCache.get(wasmName)!;
  if (!languageClass) return null;

  try {
    const require = createRequire(import.meta.url);
    const wasmsDir = join(require.resolve('tree-sitter-wasms/package.json'), '..', 'out');
    const wasmPath = join(wasmsDir, wasmName);
    const wasmBuf = await readFile(wasmPath);
    const lang = await languageClass.load(new Uint8Array(wasmBuf.buffer));
    languageCache.set(wasmName, lang);
    return lang;
  } catch {
    return null;
  }
}

// ── Abstract base class ─────────────────────────────────────────

export abstract class TreeSitterExtractor implements LanguageExtractor {
  abstract readonly language: string;
  abstract readonly extensions: string[];

  /** WASM file name, e.g. 'tree-sitter-python.wasm' */
  protected abstract readonly wasmName: string;

  protected lang: TSLanguage | null = null;

  async isAvailable(): Promise<boolean> {
    const ok = await initTreeSitter();
    if (!ok) return false;
    this.lang = await loadLanguage(this.wasmName);
    return this.lang !== null;
  }

  async extract(
    filePaths: string[],
    rootDir: string,
    options: { maxSymbols: number; timeoutMs: number; includeMethodCalls: boolean },
  ): Promise<ExtractedSymbols & { warnings: string[]; capped: boolean; fatal?: string }> {
    if (!parserClass || !this.lang) {
      return {
        classes: [], interfaces: [], functions: [], methodCalls: [],
        warnings: [], capped: false,
        fatal: `Tree-sitter or ${this.wasmName} not available.`,
      };
    }

    const parser = new parserClass();
    parser.setLanguage(this.lang);

    const start = Date.now();
    const classes: ClassInfo[] = [];
    const interfaces: InterfaceInfo[] = [];
    const functions: FunctionInfo[] = [];
    const methodCalls: MethodCallInfo[] = [];
    const warnings: string[] = [];
    let symbolCount = 0;
    let capped = false;

    const rootPrefix = rootDir.endsWith('/') ? rootDir : rootDir + '/';

    for (const filePath of filePaths) {
      if (Date.now() - start > options.timeoutMs) {
        capped = true;
        warnings.push(`Timeout after ${options.timeoutMs}ms. Returning partial results.`);
        break;
      }
      if (symbolCount >= options.maxSymbols) {
        capped = true;
        break;
      }

      try {
        const source = await readFile(filePath, 'utf-8');
        const tree = parser.parse(source);
        if (!tree) {
          warnings.push(`Failed to parse ${filePath}`);
          continue;
        }

        const relPath = filePath
          .replace(rootPrefix, '')
          .replace(new RegExp(`\\${extname(filePath)}$`), '');

        const extracted = this.extractFromTree(tree, relPath, source, options.includeMethodCalls);

        for (const c of extracted.classes) {
          if (symbolCount >= options.maxSymbols) { capped = true; break; }
          classes.push(c);
          symbolCount += 1 + c.methods.length;
        }
        if (capped) break;

        for (const i of extracted.interfaces) {
          if (symbolCount >= options.maxSymbols) { capped = true; break; }
          interfaces.push(i);
          symbolCount++;
        }
        if (capped) break;

        for (const f of extracted.functions) {
          if (symbolCount >= options.maxSymbols) { capped = true; break; }
          functions.push(f);
          symbolCount++;
        }
        if (capped) break;

        methodCalls.push(...extracted.methodCalls);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Skipped ${filePath}: ${msg}`);
      }
    }

    parser.delete();

    return { classes, interfaces, functions, methodCalls, warnings, capped };
  }

  /**
   * Language-specific extraction from a parsed tree.
   * Subclasses implement this to walk the AST and extract symbols.
   */
  protected abstract extractFromTree(
    tree: TSTree,
    relPath: string,
    source: string,
    includeMethodCalls: boolean,
  ): ExtractedSymbols;

  // ── Query helpers for subclasses ──────────────────────────────

  /** Find all descendant nodes matching a type. */
  protected findNodes(node: TSNode, type: string): TSNode[] {
    const results: TSNode[] = [];
    const walk = (n: TSNode) => {
      if (n.type === type) results.push(n);
      for (let i = 0; i < n.childCount; i++) {
        walk(n.child(i)!);
      }
    };
    walk(node);
    return results;
  }

  /** Find first child of a specific type. */
  protected findChild(node: TSNode, type: string): TSNode | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === type) return child;
    }
    return null;
  }

  /** Find all direct children of a specific type. */
  protected findChildren(node: TSNode, type: string): TSNode[] {
    const results: TSNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === type) results.push(child);
    }
    return results;
  }

  /** Get the text of a named child field. */
  protected fieldText(node: TSNode, fieldName: string): string | null {
    const child = node.childForFieldName(fieldName);
    return child ? child.text : null;
  }
}
