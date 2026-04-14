/**
 * TypeScript/JavaScript extractor — uses ts-morph for symbol-level analysis.
 * ts-morph is a peerDependency; when absent isAvailable() returns false.
 */

import { normalize, resolve } from 'node:path';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from './deep-scanner.js';
import type { LanguageExtractor, ExtractedSymbols } from './language-extractor.js';

// ── Dynamic import helper ───────────────────────────────────────

type TsMorph = typeof import('ts-morph');

async function tryImportTsMorph(): Promise<TsMorph | null> {
  try {
    return await import('ts-morph');
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function qualifiedName(filePath: string, kind: string, name: string): string {
  return `${filePath}/${kind}/${name}`;
}

function extractClasses(
  sourceFile: import('ts-morph').SourceFile,
  relPath: string,
): ClassInfo[] {
  const results: ClassInfo[] = [];
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;

    let baseClass: string | null = null;
    const baseNode = cls.getBaseClass();
    if (baseNode) {
      const baseName = baseNode.getName();
      if (baseName) {
        const baseSrc = baseNode.getSourceFile();
        const baseRel = baseSrc === sourceFile
          ? relPath
          : baseSrc.getFilePath().replace(/.*?\/src\//, 'src/').replace(/\.[tj]sx?$/, '');
        baseClass = qualifiedName(baseRel, 'class', baseName);
      }
    }

    const interfaces: string[] = [];
    for (const impl of cls.getImplements()) {
      const sym = impl.getExpression().getSymbol();
      if (sym) {
        const decls = sym.getDeclarations();
        if (decls.length > 0) {
          const decl = decls[0];
          const declFile = decl.getSourceFile();
          const declRel = declFile === sourceFile
            ? relPath
            : declFile.getFilePath().replace(/.*?\/src\//, 'src/').replace(/\.[tj]sx?$/, '');
          interfaces.push(qualifiedName(declRel, 'interface', sym.getName()));
        } else {
          interfaces.push(sym.getName());
        }
      }
    }

    const methods: ClassInfo['methods'] = [];
    for (const method of cls.getMethods()) {
      methods.push({
        name: method.getName(),
        returnType: method.getReturnType().getText(method),
        parameters: method.getParameters().map(p => ({
          name: p.getName(),
          type: p.getType().getText(p),
        })),
      });
    }

    results.push({
      name,
      filePath: relPath,
      baseClass,
      interfaces,
      methods,
      isAbstract: cls.isAbstract(),
    });
  }
  return results;
}

function extractInterfaces(
  sourceFile: import('ts-morph').SourceFile,
  relPath: string,
): InterfaceInfo[] {
  const results: InterfaceInfo[] = [];
  for (const iface of sourceFile.getInterfaces()) {
    const name = iface.getName();

    const extendsArr: string[] = [];
    for (const ext of iface.getExtends()) {
      const sym = ext.getExpression().getSymbol();
      if (sym) extendsArr.push(sym.getName());
    }

    const methods: Array<{ name: string; returnType: string }> = [];
    for (const m of iface.getMethods()) {
      methods.push({
        name: m.getName(),
        returnType: m.getReturnType().getText(m),
      });
    }

    results.push({ name, filePath: relPath, extends: extendsArr, methods });
  }
  return results;
}

function extractFunctions(
  sourceFile: import('ts-morph').SourceFile,
  relPath: string,
): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    results.push({
      name,
      filePath: relPath,
      returnType: fn.getReturnType().getText(fn),
      parameters: fn.getParameters().map(p => ({
        name: p.getName(),
        type: p.getType().getText(p),
      })),
      isExported: fn.isExported(),
    });
  }
  return results;
}

function extractMethodCalls(
  sourceFile: import('ts-morph').SourceFile,
  _relPath: string,
  ts: TsMorph,
): MethodCallInfo[] {
  const results: MethodCallInfo[] = [];
  const SyntaxKind = ts.SyntaxKind;

  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName();
    if (!className) continue;

    for (const method of cls.getMethods()) {
      const callerName = `${className}.${method.getName()}`;

      method.forEachDescendant((node) => {
        if (node.getKind() === SyntaxKind.CallExpression) {
          const callExpr = node as import('ts-morph').CallExpression;
          const expr = callExpr.getExpression();
          if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = expr as import('ts-morph').PropertyAccessExpression;
            const sym = propAccess.getSymbol();
            if (sym) {
              const decls = sym.getDeclarations();
              if (decls.length > 0) {
                const decl = decls[0];
                const parent = decl.getParent();
                if (parent && 'getName' in parent && typeof parent.getName === 'function') {
                  const parentName = parent.getName() as string;
                  if (parentName) {
                    results.push({
                      caller: callerName,
                      callee: `${parentName}.${sym.getName()}`,
                    });
                  }
                }
              }
            }
          }
        }
      });
    }
  }
  return results;
}

// ── TypeScriptExtractor ────────────────────────────────────────

export class TypeScriptExtractor implements LanguageExtractor {
  readonly language = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx'];
  readonly dependencyModel = 'file-based' as const;

  private tsMorph: TsMorph | null = null;

  async isAvailable(): Promise<boolean> {
    this.tsMorph = await tryImportTsMorph();
    return this.tsMorph !== null;
  }

  async extract(
    filePaths: string[],
    rootDir: string,
    options: { maxSymbols: number; timeoutMs: number; includeMethodCalls: boolean },
  ): Promise<ExtractedSymbols & { warnings: string[]; capped: boolean; fatal?: string }> {
    const ts = this.tsMorph ?? await tryImportTsMorph();
    if (!ts) {
      return { classes: [], interfaces: [], functions: [], methodCalls: [], warnings: ['ts-morph not available'], capped: false, fatal: 'ts-morph not installed. Run: npm install ts-morph' };
    }

    const { Project } = ts;
    let project: InstanceType<typeof Project>;
    try {
      project = new Project({
        tsConfigFilePath: `${rootDir}/tsconfig.json`,
        skipAddingFilesFromTsConfig: false,
        skipFileDependencyResolution: true,
      });
    } catch {
      return { classes: [], interfaces: [], functions: [], methodCalls: [], warnings: [], capped: false, fatal: `Failed to load tsconfig.json from ${rootDir}` };
    }

    // When a filtered file list is provided, restrict to only those files.
    // Normalise both sides with path.resolve + path.normalize to handle trailing
    // slashes, symlinks, and relative vs absolute path mismatches.
    const allowedPaths = filePaths.length > 0
      ? new Set(filePaths.map(f => normalize(resolve(rootDir, f))))
      : null;

    const sourceFiles = project.getSourceFiles()
      .filter(sf => !sf.getFilePath().includes('node_modules'))
      .filter(sf => !sf.getFilePath().includes('/dist/'))
      .filter(sf => allowedPaths === null || allowedPaths.has(normalize(sf.getFilePath())));

    const start = Date.now();
    const classes: ClassInfo[] = [];
    const interfaces: InterfaceInfo[] = [];
    const functions: FunctionInfo[] = [];
    const methodCalls: MethodCallInfo[] = [];
    const warnings: string[] = [];
    let symbolCount = 0;
    let capped = false;

    for (const sf of sourceFiles) {
      if (Date.now() - start > options.timeoutMs) {
        capped = true;
        warnings.push(`Timeout after ${options.timeoutMs}ms. Returning partial results.`);
        break;
      }

      const fullPath = sf.getFilePath();
      const relPath = fullPath
        .replace(rootDir.endsWith('/') ? rootDir : rootDir + '/', '')
        .replace(/\.[tj]sx?$/, '');

      try {
        const cls = extractClasses(sf, relPath);
        for (const c of cls) {
          if (symbolCount >= options.maxSymbols) { capped = true; break; }
          classes.push(c);
          symbolCount++;
          symbolCount += c.methods.length;
        }
        if (capped) break;

        const ifaces = extractInterfaces(sf, relPath);
        for (const i of ifaces) {
          if (symbolCount >= options.maxSymbols) { capped = true; break; }
          interfaces.push(i);
          symbolCount++;
        }
        if (capped) break;

        const fns = extractFunctions(sf, relPath);
        for (const f of fns) {
          if (symbolCount >= options.maxSymbols) { capped = true; break; }
          functions.push(f);
          symbolCount++;
        }
        if (capped) break;

        if (options.includeMethodCalls) {
          const calls = extractMethodCalls(sf, relPath, ts);
          methodCalls.push(...calls);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Skipped ${relPath}: ${msg}`);
      }
    }

    return { classes, interfaces, functions, methodCalls, warnings, capped };
  }
}
