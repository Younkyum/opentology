/**
 * Swift extractor — uses Tree-sitter to extract classes, structs, protocols, and functions.
 * Swift class/struct → ClassInfo, Swift protocol → InterfaceInfo.
 */

import { TreeSitterExtractor } from '../deep-scanner-treesitter.js';
import type { TSNode, TSTree } from '../deep-scanner-treesitter.js';
import type { ExtractedSymbols } from '../language-extractor.js';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from '../deep-scanner.js';

export class SwiftExtractor extends TreeSitterExtractor {
  readonly language = 'swift';
  readonly extensions = ['.swift'];
  protected readonly wasmName = 'tree-sitter-swift.wasm';

  protected extractFromTree(
    tree: TSTree,
    relPath: string,
    _source: string,
    includeMethodCalls: boolean,
  ): ExtractedSymbols {
    const classes: ClassInfo[] = [];
    const interfaces: InterfaceInfo[] = [];
    const functions: FunctionInfo[] = [];
    const methodCalls: MethodCallInfo[] = [];
    const root = tree.rootNode;

    // ── Classes ──
    for (const node of this.findNodes(root, 'class_declaration')) {
      const info = this.extractClassLike(node, relPath, includeMethodCalls, methodCalls);
      if (info) classes.push(info);
    }

    // ── Structs → ClassInfo ──
    for (const node of this.findNodes(root, 'struct_declaration')) {
      const info = this.extractClassLike(node, relPath, includeMethodCalls, methodCalls);
      if (info) classes.push(info);
    }

    // ── Protocols → InterfaceInfo ──
    for (const node of this.findNodes(root, 'protocol_declaration')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      const inheritances = this.getInheritances(node);
      const methods: Array<{ name: string; returnType: string }> = [];

      const body = this.findChild(node, 'protocol_body');
      if (body) {
        for (const fn of this.findNodes(body, 'function_declaration')) {
          const fnName = this.fieldText(fn, 'name');
          if (fnName) {
            methods.push({ name: fnName, returnType: this.getReturnType(fn) });
          }
        }
      }

      interfaces.push({ name, filePath: relPath, extends: inheritances, methods });
    }

    // ── Top-level functions ──
    for (const node of this.findChildren(root, 'function_declaration')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      functions.push({
        name,
        filePath: relPath,
        returnType: this.getReturnType(node),
        parameters: this.extractParams(node),
        isExported: !name.startsWith('_'),
      });
    }

    return { classes, interfaces, functions, methodCalls };
  }

  private extractClassLike(
    node: TSNode,
    relPath: string,
    includeMethodCalls: boolean,
    methodCalls: MethodCallInfo[],
  ): ClassInfo | null {
    const name = this.fieldText(node, 'name');
    if (!name) return null;

    const inheritances = this.getInheritances(node);
    // First inheritance is typically the superclass for classes
    const baseClass = node.type === 'class_declaration' && inheritances.length > 0
      ? inheritances[0]
      : null;
    const protocols = baseClass ? inheritances.slice(1) : inheritances;

    const methods: ClassInfo['methods'] = [];
    const body = this.findChild(node, 'class_body') ?? this.findChild(node, 'struct_body');
    if (body) {
      for (const fn of this.findNodes(body, 'function_declaration')) {
        const fnName = this.fieldText(fn, 'name');
        if (!fnName) continue;

        methods.push({
          name: fnName,
          returnType: this.getReturnType(fn),
          parameters: this.extractParams(fn),
        });

        if (includeMethodCalls) {
          const callerName = `${name}.${fnName}`;
          for (const call of this.findNodes(fn, 'call_expression')) {
            const fnExpr = call.childForFieldName('function');
            if (fnExpr && fnExpr.type === 'navigation_expression') {
              const target = fnExpr.childForFieldName('target');
              const suffix = fnExpr.childForFieldName('suffix');
              if (target && suffix) {
                methodCalls.push({
                  caller: callerName,
                  callee: `${target.text}.${suffix.text}`,
                });
              }
            }
          }
        }
      }
    }

    return {
      name,
      filePath: relPath,
      baseClass,
      interfaces: protocols,
      methods,
      isAbstract: false,
    };
  }

  private getInheritances(node: TSNode): string[] {
    const result: string[] = [];
    const inheritanceClause = this.findChild(node, 'type_inheritance_clause');
    if (!inheritanceClause) return result;

    for (const typeId of this.findNodes(inheritanceClause, 'user_type')) {
      result.push(typeId.text);
    }
    if (result.length === 0) {
      // Fallback: try type_identifier
      for (const typeId of this.findNodes(inheritanceClause, 'type_identifier')) {
        result.push(typeId.text);
      }
    }
    return result;
  }

  private extractParams(fn: TSNode): Array<{ name: string; type: string }> {
    const params: Array<{ name: string; type: string }> = [];
    for (const param of this.findNodes(fn, 'parameter')) {
      const name = param.childForFieldName('external_name')?.text
        ?? param.childForFieldName('name')?.text
        ?? '';
      const typeNode = param.childForFieldName('type');
      if (name !== '_') {
        params.push({ name, type: typeNode?.text ?? '' });
      }
    }
    return params;
  }

  private getReturnType(fn: TSNode): string {
    // Look for return type annotation after '->'
    for (let i = 0; i < fn.childCount; i++) {
      const child = fn.child(i)!;
      if (child.type === 'type_annotation' || child.type === 'function_type') {
        return child.text.replace(/^->\s*/, '');
      }
    }
    return 'Void';
  }
}
