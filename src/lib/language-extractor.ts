/**
 * Language extractor interface — common contract for all language-specific
 * symbol extractors (ts-morph, tree-sitter, etc.).
 */

import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from './deep-scanner.js';

export interface ExtractedSymbols {
  classes: ClassInfo[];
  interfaces: InterfaceInfo[];
  functions: FunctionInfo[];
  methodCalls: MethodCallInfo[];
}

/** How a language resolves inter-file dependencies. */
export type DependencyModel = 'file-based' | 'package-based' | 'framework-based';

export interface LanguageExtractor {
  /** Language identifier, e.g. 'typescript', 'python', 'go' */
  readonly language: string;

  /** File extensions handled by this extractor, e.g. ['.ts', '.tsx'] */
  readonly extensions: string[];

  /** How this language resolves dependencies between source files. */
  readonly dependencyModel: DependencyModel;

  /** Check whether the extractor's dependencies are available at runtime. */
  isAvailable(): Promise<boolean>;

  /**
   * Extract symbols from the given source files.
   * @param filePaths  Absolute paths to source files for this language.
   * @param rootDir    Project root directory (for computing relative paths).
   * @param options    Shared scan options.
   */
  extract(
    filePaths: string[],
    rootDir: string,
    options: { maxSymbols: number; timeoutMs: number; includeMethodCalls: boolean },
  ): Promise<ExtractedSymbols & { warnings: string[]; capped: boolean; fatal?: string }>;
}
