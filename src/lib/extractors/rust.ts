/**
 * Rust extractor — uses Tree-sitter to extract structs, traits, functions, and impl blocks.
 * Rust structs → ClassInfo, Rust traits → InterfaceInfo, impl Trait for Struct → interfaces[].
 */

import { TreeSitterExtractor } from '../deep-scanner-treesitter.js';
import type { TSNode, TSTree } from '../deep-scanner-treesitter.js';
import type { ExtractedSymbols } from '../language-extractor.js';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from '../deep-scanner.js';

export class RustExtractor extends TreeSitterExtractor {
  readonly language = 'rust';
  readonly extensions = ['.rs'];
  protected readonly wasmName = 'tree-sitter-rust.wasm';

  protected extractFromTree(
    tree: TSTree,
    relPath: string,
    _source: string,
    includeMethodCalls: boolean,
  ): ExtractedSymbols {
    const classMap = new Map<string, ClassInfo>();
    const interfaces: InterfaceInfo[] = [];
    const functions: FunctionInfo[] = [];
    const methodCalls: MethodCallInfo[] = [];
    const root = tree.rootNode;

    // ── Structs ──
    for (const node of this.findNodes(root, 'struct_item')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;
      classMap.set(name, {
        name,
        filePath: relPath,
        baseClass: null,
        interfaces: [],
        methods: [],
        isAbstract: false,
      });
    }

    // ── Enum items (treated as classes) ──
    for (const node of this.findNodes(root, 'enum_item')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;
      classMap.set(name, {
        name,
        filePath: relPath,
        baseClass: null,
        interfaces: [],
        methods: [],
        isAbstract: false,
      });
    }

    // ── Traits → InterfaceInfo ──
    for (const node of this.findNodes(root, 'trait_item')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      const methods: Array<{ name: string; returnType: string }> = [];
      const body = this.findChild(node, 'declaration_list');
      if (body) {
        for (const fn of this.findChildren(body, 'function_signature_item')) {
          const fnName = this.fieldText(fn, 'name');
          if (fnName) {
            methods.push({ name: fnName, returnType: this.getReturnType(fn) });
          }
        }
        for (const fn of this.findChildren(body, 'function_item')) {
          const fnName = this.fieldText(fn, 'name');
          if (fnName) {
            methods.push({ name: fnName, returnType: this.getReturnType(fn) });
          }
        }
      }

      // Trait bounds (supertraits)
      const bounds = this.findChild(node, 'trait_bounds');
      const extendsArr: string[] = [];
      if (bounds) {
        for (const bound of this.findNodes(bounds, 'type_identifier')) {
          extendsArr.push(bound.text);
        }
      }

      interfaces.push({ name, filePath: relPath, extends: extendsArr, methods });
    }

    // ── impl blocks ──
    for (const node of this.findNodes(root, 'impl_item')) {
      const traitNode = node.childForFieldName('trait');
      const typeNode = node.childForFieldName('type');
      const structName = typeNode?.text?.replace(/^\*/, '') ?? null;
      const traitName = traitNode?.text ?? null;

      // Get methods from impl body
      const body = this.findChild(node, 'declaration_list');
      const implMethods: ClassInfo['methods'] = [];
      if (body) {
        for (const fn of this.findChildren(body, 'function_item')) {
          const fnName = this.fieldText(fn, 'name');
          if (!fnName) continue;
          implMethods.push({
            name: fnName,
            returnType: this.getReturnType(fn),
            parameters: this.extractParams(fn),
          });

          if (includeMethodCalls && structName) {
            const callerName = `${structName}.${fnName}`;
            for (const call of this.findNodes(fn, 'call_expression')) {
              const fnExpr = call.childForFieldName('function');
              if (fnExpr && fnExpr.type === 'field_expression') {
                const field = fnExpr.childForFieldName('field');
                const value = fnExpr.childForFieldName('value');
                if (field && value) {
                  methodCalls.push({
                    caller: callerName,
                    callee: `${value.text}.${field.text}`,
                  });
                }
              }
            }
          }
        }
      }

      if (structName) {
        let cls = classMap.get(structName);
        if (!cls) {
          cls = {
            name: structName,
            filePath: relPath,
            baseClass: null,
            interfaces: [],
            methods: [],
            isAbstract: false,
          };
          classMap.set(structName, cls);
        }
        cls.methods.push(...implMethods);
        if (traitName) {
          cls.interfaces.push(traitName);
        }
      }
    }

    // ── Top-level functions ──
    for (const node of this.findChildren(root, 'function_item')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      functions.push({
        name,
        filePath: relPath,
        returnType: this.getReturnType(node),
        parameters: this.extractParams(node),
        isExported: this.hasVisibility(node, 'pub'),
      });
    }

    return {
      classes: [...classMap.values()],
      interfaces,
      functions,
      methodCalls,
    };
  }

  private extractParams(fn: TSNode): Array<{ name: string; type: string }> {
    const params: Array<{ name: string; type: string }> = [];
    const paramList = fn.childForFieldName('parameters');
    if (!paramList) return params;

    for (const param of this.findNodes(paramList, 'parameter')) {
      const pattern = param.childForFieldName('pattern');
      const typeNode = param.childForFieldName('type');
      if (pattern && pattern.text !== 'self' && pattern.text !== '&self' && pattern.text !== '&mut self') {
        params.push({ name: pattern.text, type: typeNode?.text ?? '' });
      }
    }
    return params;
  }

  private getReturnType(fn: TSNode): string {
    const retType = fn.childForFieldName('return_type');
    return retType ? retType.text : 'void';
  }

  private hasVisibility(node: TSNode, vis: string): boolean {
    const visNode = this.findChild(node, 'visibility_modifier');
    return visNode?.text?.includes(vis) ?? false;
  }
}
