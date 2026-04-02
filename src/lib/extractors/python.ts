/**
 * Python extractor — uses Tree-sitter to extract classes, functions, and method calls.
 * Maps Python ABC/Protocol subclasses to InterfaceInfo.
 */

import { TreeSitterExtractor } from '../deep-scanner-treesitter.js';
import type { TSNode, TSTree } from '../deep-scanner-treesitter.js';
import type { ExtractedSymbols } from '../language-extractor.js';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from '../deep-scanner.js';

const PROTOCOL_BASES = new Set(['ABC', 'ABCMeta', 'Protocol']);

export class PythonExtractor extends TreeSitterExtractor {
  readonly language = 'python';
  readonly extensions = ['.py'];
  protected readonly wasmName = 'tree-sitter-python.wasm';

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
    for (const node of this.findNodes(root, 'class_definition')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      const bases = this.getBaseClasses(node);
      const isProtocol = bases.some(b => PROTOCOL_BASES.has(b));
      const methods = this.extractMethods(node, relPath);

      if (isProtocol) {
        interfaces.push({
          name,
          filePath: relPath,
          extends: bases.filter(b => !PROTOCOL_BASES.has(b)),
          methods: methods.map(m => ({ name: m.name, returnType: m.returnType })),
        });
      } else {
        classes.push({
          name,
          filePath: relPath,
          baseClass: bases.length > 0 ? bases[0] : null,
          interfaces: bases.filter(b => PROTOCOL_BASES.has(b)),
          methods,
          isAbstract: this.hasAbstractDecorator(node),
        });
      }

      // ── Method calls ──
      if (includeMethodCalls) {
        for (const method of this.findChildren(this.findChild(node, 'block') ?? node, 'function_definition')) {
          const methodName = this.fieldText(method, 'name');
          if (!methodName || methodName.startsWith('_')) continue;
          const callerName = `${name}.${methodName}`;

          for (const call of this.findNodes(method, 'call')) {
            const fn = call.childForFieldName('function');
            if (fn && fn.type === 'attribute') {
              const obj = fn.childForFieldName('object');
              const attr = fn.childForFieldName('attribute');
              if (obj && attr) {
                methodCalls.push({
                  caller: callerName,
                  callee: `${obj.text}.${attr.text}`,
                });
              }
            }
          }
        }
      }
    }

    // ── Top-level functions ──
    for (const node of this.findChildren(root, 'function_definition')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      const params = this.extractParams(node);
      const returnType = this.getReturnAnnotation(node);
      const isDecorated = this.findChildren(node.parent ?? root, 'decorator').length > 0;

      functions.push({
        name,
        filePath: relPath,
        returnType,
        parameters: params,
        isExported: !name.startsWith('_'),
      });
    }

    return { classes, interfaces, functions, methodCalls };
  }

  private getBaseClasses(node: TSNode): string[] {
    const argList = this.findChild(node, 'argument_list');
    if (!argList) return [];
    const bases: string[] = [];
    for (let i = 0; i < argList.childCount; i++) {
      const child = argList.child(i)!;
      if (child.type === 'identifier' || child.type === 'attribute') {
        bases.push(child.text);
      }
    }
    return bases;
  }

  private hasAbstractDecorator(node: TSNode): boolean {
    // Check preceding siblings for decorators
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.type === 'decorator') {
        const text = sibling.text;
        if (text.includes('abstractmethod') || text.includes('ABC')) return true;
      }
      if (sibling.type !== 'decorator' && sibling.type !== 'comment') break;
      sibling = sibling.previousSibling;
    }
    return false;
  }

  private extractMethods(classNode: TSNode, _relPath: string): ClassInfo['methods'] {
    const block = this.findChild(classNode, 'block');
    if (!block) return [];

    const methods: ClassInfo['methods'] = [];
    for (const fn of this.findChildren(block, 'function_definition')) {
      const name = this.fieldText(fn, 'name');
      if (!name || name === '__init__') continue;

      methods.push({
        name,
        returnType: this.getReturnAnnotation(fn),
        parameters: this.extractParams(fn).filter(p => p.name !== 'self' && p.name !== 'cls'),
      });
    }
    return methods;
  }

  private extractParams(fn: TSNode): Array<{ name: string; type: string }> {
    const params: Array<{ name: string; type: string }> = [];
    const paramList = this.findChild(fn, 'parameters');
    if (!paramList) return params;

    for (let i = 0; i < paramList.childCount; i++) {
      const p = paramList.child(i)!;
      if (p.type === 'identifier') {
        params.push({ name: p.text, type: 'Any' });
      } else if (p.type === 'typed_parameter') {
        const name = this.fieldText(p, 'name') ?? p.child(0)?.text ?? '';
        const typeNode = p.childForFieldName('type');
        params.push({ name, type: typeNode?.text ?? 'Any' });
      }
    }
    return params;
  }

  private getReturnAnnotation(fn: TSNode): string {
    const retType = fn.childForFieldName('return_type');
    return retType ? retType.text : 'None';
  }
}
