/**
 * Java extractor — uses Tree-sitter to extract classes, interfaces, methods, and calls.
 * Direct mapping: Java class → ClassInfo, Java interface → InterfaceInfo.
 */

import { TreeSitterExtractor } from '../deep-scanner-treesitter.js';
import type { TSNode, TSTree } from '../deep-scanner-treesitter.js';
import type { ExtractedSymbols } from '../language-extractor.js';
import type { ClassInfo, InterfaceInfo, FunctionInfo, MethodCallInfo } from '../deep-scanner.js';

export class JavaExtractor extends TreeSitterExtractor {
  readonly language = 'java';
  readonly extensions = ['.java'];
  protected readonly wasmName = 'tree-sitter-java.wasm';

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
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      const superclass = this.getSuperclass(node);
      const ifaces = this.getImplementedInterfaces(node);
      const methods = this.extractMethods(node);
      const isAbstract = this.hasModifier(node, 'abstract');

      classes.push({
        name,
        filePath: relPath,
        baseClass: superclass,
        interfaces: ifaces,
        methods,
        isAbstract,
      });

      if (includeMethodCalls) {
        for (const method of this.findNodes(node, 'method_declaration')) {
          const methodName = this.fieldText(method, 'name');
          if (!methodName) continue;
          const callerName = `${name}.${methodName}`;

          for (const call of this.findNodes(method, 'method_invocation')) {
            const obj = call.childForFieldName('object');
            const methodRef = call.childForFieldName('name');
            if (obj && methodRef) {
              methodCalls.push({
                caller: callerName,
                callee: `${obj.text}.${methodRef.text}`,
              });
            }
          }
        }
      }
    }

    // ── Interfaces ──
    for (const node of this.findNodes(root, 'interface_declaration')) {
      const name = this.fieldText(node, 'name');
      if (!name) continue;

      const extendsArr = this.getExtendsInterfaces(node);
      const methods: Array<{ name: string; returnType: string }> = [];

      for (const method of this.findNodes(node, 'method_declaration')) {
        const methodName = this.fieldText(method, 'name');
        const retType = this.getMethodReturnType(method);
        if (methodName) {
          methods.push({ name: methodName, returnType: retType });
        }
      }

      interfaces.push({ name, filePath: relPath, extends: extendsArr, methods });
    }

    return { classes, interfaces, functions, methodCalls };
  }

  private getSuperclass(node: TSNode): string | null {
    const superclass = node.childForFieldName('superclass');
    if (!superclass) return null;
    // superclass node wraps the type name
    const typeNode = this.findChild(superclass, 'type_identifier');
    return typeNode?.text ?? superclass.text.replace(/^extends\s+/, '');
  }

  private getImplementedInterfaces(node: TSNode): string[] {
    const result: string[] = [];
    const interfaces = node.childForFieldName('interfaces');
    if (!interfaces) return result;
    for (const typeId of this.findNodes(interfaces, 'type_identifier')) {
      result.push(typeId.text);
    }
    return result;
  }

  private getExtendsInterfaces(node: TSNode): string[] {
    const result: string[] = [];
    // Look for extends_interfaces or type_list after 'extends'
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === 'extends_interfaces' || child.type === 'type_list') {
        for (const typeId of this.findNodes(child, 'type_identifier')) {
          result.push(typeId.text);
        }
      }
    }
    return result;
  }

  private extractMethods(classNode: TSNode): ClassInfo['methods'] {
    const methods: ClassInfo['methods'] = [];
    const body = this.findChild(classNode, 'class_body');
    if (!body) return methods;

    for (const method of this.findChildren(body, 'method_declaration')) {
      const name = this.fieldText(method, 'name');
      if (!name) continue;

      methods.push({
        name,
        returnType: this.getMethodReturnType(method),
        parameters: this.extractParams(method),
      });
    }
    return methods;
  }

  private extractParams(method: TSNode): Array<{ name: string; type: string }> {
    const params: Array<{ name: string; type: string }> = [];
    const paramList = method.childForFieldName('parameters');
    if (!paramList) return params;

    for (const param of this.findNodes(paramList, 'formal_parameter')) {
      const name = this.fieldText(param, 'name');
      const typeNode = param.childForFieldName('type');
      if (name) {
        params.push({ name, type: typeNode?.text ?? '' });
      }
    }
    return params;
  }

  private getMethodReturnType(method: TSNode): string {
    const typeNode = method.childForFieldName('type');
    return typeNode?.text ?? 'void';
  }

  private hasModifier(node: TSNode, modifier: string): boolean {
    const modifiers = this.findChild(node, 'modifiers');
    if (!modifiers) return false;
    return modifiers.text.includes(modifier);
  }
}
