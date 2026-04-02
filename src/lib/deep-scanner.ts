/**
 * Deep scanner — symbol-level codebase analysis using ts-morph.
 * ts-morph is a peerDependency; when absent the scan gracefully degrades.
 */

// ── Exported types ──────────────────────────────────────────────

export interface DeepScanOptions {
  maxFiles?: number;            // default 500
  maxSymbols?: number;          // default 300
  timeoutMs?: number;           // default 30_000
  includeMethodCalls?: boolean; // default false
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

export interface DeepScanResult {
  deepScanAvailable: true;
  classes: ClassInfo[];
  interfaces: InterfaceInfo[];
  functions: FunctionInfo[];
  methodCalls: MethodCallInfo[];
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

// ── Dynamic import helper ───────────────────────────────────────

type TsMorph = typeof import('ts-morph');

async function tryImportTsMorph(): Promise<TsMorph | null> {
  try {
    return await import('ts-morph');
  } catch {
    return null;
  }
}

// ── Extractors ──────────────────────────────────────────────────

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

    const methods: MethodInfo[] = [];
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
  relPath: string,
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

// ── Main entry point ────────────────────────────────────────────

export async function deepScan(
  rootDir: string,
  options?: DeepScanOptions,
): Promise<DeepScanOutput> {
  const ts = await tryImportTsMorph();
  if (!ts) {
    return {
      deepScanAvailable: false,
      error: 'ts-morph not installed. Run: npm install ts-morph',
      fallback: null,
    };
  }

  const maxFiles = options?.maxFiles ?? 500;
  const maxSymbols = options?.maxSymbols ?? 300;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const includeMethodCalls = options?.includeMethodCalls ?? false;

  const start = Date.now();
  const warnings: string[] = [];

  // Initialise ts-morph Project
  const { Project } = ts;
  let project: InstanceType<typeof Project>;
  try {
    project = new Project({
      tsConfigFilePath: `${rootDir}/tsconfig.json`,
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: true,
    });
  } catch {
    return {
      deepScanAvailable: false,
      error: `Failed to load tsconfig.json from ${rootDir}`,
      fallback: null,
    };
  }

  const sourceFiles = project.getSourceFiles()
    .filter(sf => !sf.getFilePath().includes('node_modules'))
    .filter(sf => !sf.getFilePath().includes('/dist/'));

  if (sourceFiles.length > maxFiles) {
    return {
      deepScanAvailable: true,
      classes: [],
      interfaces: [],
      functions: [],
      methodCalls: [],
      fileCount: sourceFiles.length,
      symbolCount: 0,
      scanDurationMs: Date.now() - start,
      capped: true,
      warnings: [`File count ${sourceFiles.length} exceeds maxFiles ${maxFiles}. Scan skipped.`],
    };
  }

  const classes: ClassInfo[] = [];
  const interfaces: InterfaceInfo[] = [];
  const functions: FunctionInfo[] = [];
  const methodCalls: MethodCallInfo[] = [];
  let symbolCount = 0;
  let capped = false;

  for (const sf of sourceFiles) {
    if (Date.now() - start > timeoutMs) {
      capped = true;
      warnings.push(`Timeout after ${timeoutMs}ms. Returning partial results.`);
      break;
    }

    const fullPath = sf.getFilePath();
    const relPath = fullPath
      .replace(rootDir.endsWith('/') ? rootDir : rootDir + '/', '')
      .replace(/\.[tj]sx?$/, '');

    try {
      const cls = extractClasses(sf, relPath);
      for (const c of cls) {
        if (symbolCount >= maxSymbols) { capped = true; break; }
        classes.push(c);
        symbolCount++;
        // Count methods as symbols too
        symbolCount += c.methods.length;
      }
      if (capped) break;

      const ifaces = extractInterfaces(sf, relPath);
      for (const i of ifaces) {
        if (symbolCount >= maxSymbols) { capped = true; break; }
        interfaces.push(i);
        symbolCount++;
      }
      if (capped) break;

      const fns = extractFunctions(sf, relPath);
      for (const f of fns) {
        if (symbolCount >= maxSymbols) { capped = true; break; }
        functions.push(f);
        symbolCount++;
      }
      if (capped) break;

      if (includeMethodCalls) {
        const calls = extractMethodCalls(sf, relPath, ts);
        methodCalls.push(...calls);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Skipped ${relPath}: ${msg}`);
    }
  }

  return {
    deepScanAvailable: true,
    classes,
    interfaces,
    functions,
    methodCalls,
    fileCount: sourceFiles.length,
    symbolCount,
    scanDurationMs: Date.now() - start,
    capped,
    warnings,
  };
}
