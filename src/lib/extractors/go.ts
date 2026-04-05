/**
 * Go extractor — uses Tree-sitter to extract structs, interfaces, functions, and method calls.
 * Go structs → ClassInfo, Go interfaces → InterfaceInfo.
 */

import { TreeSitterExtractor } from '../deep-scanner-treesitter.js';
import type { TSNode, TSTree } from '../deep-scanner-treesitter.js';
import type { ExtractedSymbols } from '../language-extractor.js';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from '../deep-scanner.js';

export class GoExtractor extends TreeSitterExtractor {
  readonly language = 'go';
  readonly extensions = ['.go'];
  readonly dependencyModel = 'package-based' as const;
  protected readonly wasmName = 'tree-sitter-go.wasm';

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

    // ── Type declarations ──
    for (const typeDecl of this.findNodes(root, 'type_declaration')) {
      for (const typeSpec of this.findChildren(typeDecl, 'type_spec')) {
        const name = this.fieldText(typeSpec, 'name');
        if (!name) continue;
        const typeNode = typeSpec.childForFieldName('type');
        if (!typeNode) continue;

        if (typeNode.type === 'struct_type') {
          const { embedded, methods: fieldMethods } = this.extractStructFields(typeNode);
          classes.push({
            name,
            filePath: relPath,
            baseClass: embedded.length > 0 ? embedded[0] : null,
            interfaces: [],
            methods: fieldMethods,
            isAbstract: false,
          });
        } else if (typeNode.type === 'interface_type') {
          const methods = this.extractInterfaceMethods(typeNode);
          const extendsArr = this.extractInterfaceEmbeds(typeNode);
          interfaces.push({
            name,
            filePath: relPath,
            extends: extendsArr,
            methods,
          });
        }
      }
    }

    // ── Functions and methods ──
    for (const fn of this.findNodes(root, 'function_declaration')) {
      const name = this.fieldText(fn, 'name');
      if (!name) continue;

      functions.push({
        name,
        filePath: relPath,
        returnType: this.getReturnType(fn),
        parameters: this.extractParams(fn),
        isExported: name[0] === name[0].toUpperCase(),
      });
    }

    // ── Method declarations (receiver functions) ──
    for (const method of this.findNodes(root, 'method_declaration')) {
      const name = this.fieldText(method, 'name');
      if (!name) continue;

      const receiver = this.getReceiverType(method);
      if (receiver) {
        const cls = classes.find(c => c.name === receiver);
        if (cls) {
          cls.methods.push({
            name,
            returnType: this.getReturnType(method),
            parameters: this.extractParams(method),
          });
        }
      }

      if (includeMethodCalls && receiver) {
        const callerName = `${receiver}.${name}`;
        for (const call of this.findNodes(method, 'call_expression')) {
          const fnNode = call.childForFieldName('function');
          if (fnNode && fnNode.type === 'selector_expression') {
            const operand = fnNode.childForFieldName('operand');
            const field = fnNode.childForFieldName('field');
            if (operand && field) {
              methodCalls.push({
                caller: callerName,
                callee: `${operand.text}.${field.text}`,
              });
            }
          }
        }
      }
    }

    return { classes, interfaces, functions, methodCalls };
  }

  private extractStructFields(structNode: TSNode): { embedded: string[]; methods: ClassInfo['methods'] } {
    const embedded: string[] = [];
    const fieldList = this.findChild(structNode, 'field_declaration_list');
    if (!fieldList) return { embedded, methods: [] };

    for (const field of this.findChildren(fieldList, 'field_declaration')) {
      // Embedded struct: no field name, just a type
      const nameNode = field.childForFieldName('name');
      const typeNode = field.childForFieldName('type');
      if (!nameNode && typeNode) {
        embedded.push(typeNode.text);
      }
    }
    return { embedded, methods: [] };
  }

  private extractInterfaceMethods(ifaceNode: TSNode): Array<{ name: string; returnType: string }> {
    const methods: Array<{ name: string; returnType: string }> = [];
    // Interface methods are method_spec nodes inside the interface body
    for (const spec of this.findNodes(ifaceNode, 'method_spec')) {
      const name = this.fieldText(spec, 'name');
      if (name) {
        methods.push({ name, returnType: this.getReturnType(spec) });
      }
    }
    return methods;
  }

  private extractInterfaceEmbeds(ifaceNode: TSNode): string[] {
    const embeds: string[] = [];
    // Embedded interfaces appear as type_name or qualified_type inside interface body
    for (const child of this.findNodes(ifaceNode, 'type_name')) {
      embeds.push(child.text);
    }
    return embeds;
  }

  private getReceiverType(method: TSNode): string | null {
    const receiver = method.childForFieldName('receiver');
    if (!receiver) return null;
    // Walk through parameter list to find the type
    const paramList = this.findChild(receiver, 'parameter_list');
    if (!paramList) return null;
    for (let i = 0; i < paramList.childCount; i++) {
      const param = paramList.child(i)!;
      const typeNode = param.childForFieldName('type');
      if (typeNode) {
        // Strip pointer: *Foo → Foo
        return typeNode.text.replace(/^\*/, '');
      }
    }
    return null;
  }

  private extractParams(fn: TSNode): Array<{ name: string; type: string }> {
    const params: Array<{ name: string; type: string }> = [];
    const paramList = fn.childForFieldName('parameters');
    if (!paramList) return params;

    for (const param of this.findNodes(paramList, 'parameter_declaration')) {
      const name = this.fieldText(param, 'name') ?? '';
      const typeNode = param.childForFieldName('type');
      params.push({ name, type: typeNode?.text ?? '' });
    }
    return params;
  }

  private getReturnType(fn: TSNode): string {
    const result = fn.childForFieldName('result');
    return result ? result.text : 'void';
  }
}
