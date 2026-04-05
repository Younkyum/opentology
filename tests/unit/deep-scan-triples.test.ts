import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import {
  generateSymbolTriples,
  batchTriples,
  pushSymbolTriples,
} from '../../src/lib/deep-scan-triples.js';
import type { DeepScanResult } from '../../src/lib/deep-scanner.js';

function makeResult(overrides?: Partial<DeepScanResult>): DeepScanResult {
  return {
    deepScanAvailable: true,
    classes: [],
    interfaces: [],
    functions: [],
    methodCalls: [],
    unsupportedFiles: [],
    languageHints: [],
    fileCount: 1,
    symbolCount: 0,
    scanDurationMs: 100,
    capped: false,
    warnings: [],
    ...overrides,
  };
}

describe('generateSymbolTriples', () => {
  it('generates valid Turtle that parses via N3', () => {
    const result = makeResult({
      classes: [{
        name: 'Foo',
        filePath: 'src/lib/foo',
        baseClass: null,
        interfaces: [],
        methods: [{ name: 'bar', returnType: 'string', parameters: [] }],
        isAbstract: false,
      }],
    });

    const triples = generateSymbolTriples(result);
    expect(triples.length).toBeGreaterThan(0);

    // Parse as Turtle — N3 parser needs a base and prefix-free NTriples-like format
    const parser = new Parser({ format: 'N-Triples' });
    const quads = parser.parse(triples.join('\n'));
    expect(quads.length).toBeGreaterThan(0);
  });

  it('produces otx:Class triple for classes', () => {
    const result = makeResult({
      classes: [{
        name: 'MyClass',
        filePath: 'src/app',
        baseClass: null,
        interfaces: [],
        methods: [],
        isAbstract: false,
      }],
    });

    const triples = generateSymbolTriples(result);
    const classTriple = triples.find(t => t.includes('vocab#Class'));
    expect(classTriple).toBeDefined();
    expect(classTriple).toContain('urn:symbol:');
  });

  it('produces otx:extends triple for inheritance', () => {
    const result = makeResult({
      classes: [{
        name: 'Child',
        filePath: 'src/child',
        baseClass: 'src/parent/class/Parent',
        interfaces: [],
        methods: [],
        isAbstract: false,
      }],
    });

    const triples = generateSymbolTriples(result);
    const extendsTriple = triples.find(t => t.includes('vocab#extends'));
    expect(extendsTriple).toBeDefined();
    expect(extendsTriple).toContain('Parent');
  });

  it('produces otx:implements triple for interface implementation', () => {
    const result = makeResult({
      classes: [{
        name: 'Impl',
        filePath: 'src/impl',
        baseClass: null,
        interfaces: ['src/types/interface/Serializable'],
        methods: [],
        isAbstract: false,
      }],
    });

    const triples = generateSymbolTriples(result);
    const implTriple = triples.find(t => t.includes('vocab#implements'));
    expect(implTriple).toBeDefined();
    expect(implTriple).toContain('Serializable');
  });

  it('produces otx:definedIn for every symbol', () => {
    const result = makeResult({
      classes: [{
        name: 'A',
        filePath: 'src/a',
        baseClass: null,
        interfaces: [],
        methods: [],
        isAbstract: false,
      }],
      interfaces: [{
        name: 'B',
        filePath: 'src/b',
        extends: [],
        methods: [],
      }],
      functions: [{
        name: 'c',
        filePath: 'src/c',
        returnType: 'void',
        parameters: [],
        isExported: true,
      }],
    });

    const triples = generateSymbolTriples(result);
    const definedInTriples = triples.filter(t => t.includes('vocab#definedIn'));
    // class A, interface B, function c → at least 3 definedIn triples
    expect(definedInTriples.length).toBeGreaterThanOrEqual(3);
  });

  it('produces no rdfs:subClassOf triples', () => {
    const result = makeResult({
      classes: [{
        name: 'X',
        filePath: 'src/x',
        baseClass: null,
        interfaces: [],
        methods: [{ name: 'm', returnType: 'void', parameters: [] }],
        isAbstract: false,
      }],
    });

    const triples = generateSymbolTriples(result);
    const subClassTriples = triples.filter(t => t.includes('subClassOf'));
    expect(subClassTriples.length).toBe(0);
  });

  it('produces otx:Interface triple for interfaces', () => {
    const result = makeResult({
      interfaces: [{
        name: 'MyInterface',
        filePath: 'src/types',
        extends: [],
        methods: [{ name: 'doSomething', returnType: 'void' }],
      }],
    });

    const triples = generateSymbolTriples(result);
    const ifaceTriple = triples.find(t => t.includes('vocab#Interface'));
    expect(ifaceTriple).toBeDefined();
  });

  it('produces otx:MethodCall triples with caller/callee symbols', () => {
    const result = makeResult({
      methodCalls: [
        { caller: 'Foo.bar', callee: 'Baz.qux' },
        { caller: 'handlePush', callee: 'persistGraph' },
      ],
    });

    const triples = generateSymbolTriples(result);

    // Should have rdf:type MethodCall
    const typeTriples = triples.filter(t => t.includes('vocab#MethodCall'));
    expect(typeTriples.length).toBe(2);

    // Should have callerSymbol and calleeSymbol
    const callerTriples = triples.filter(t => t.includes('vocab#callerSymbol'));
    expect(callerTriples.length).toBe(2);
    const calleeTriples = triples.filter(t => t.includes('vocab#calleeSymbol'));
    expect(calleeTriples.length).toBe(2);

    // Should have title with "caller -> callee" format
    const titleTriples = triples.filter(t => t.includes('->'));
    expect(titleTriples.length).toBe(2);
    expect(titleTriples[0]).toContain('Foo.bar');
    expect(titleTriples[0]).toContain('Baz.qux');

    // Should parse as valid N-Triples
    const parser = new Parser({ format: 'N-Triples' });
    const quads = parser.parse(triples.join('\n'));
    expect(quads.length).toBeGreaterThan(0);
  });

  it('produces otx:Function triple for functions', () => {
    const result = makeResult({
      functions: [{
        name: 'helper',
        filePath: 'src/utils',
        returnType: 'string',
        parameters: [{ name: 'x', type: 'number' }],
        isExported: true,
      }],
    });

    const triples = generateSymbolTriples(result);
    const fnTriple = triples.find(t => t.includes('vocab#Function'));
    expect(fnTriple).toBeDefined();
    const returnsTriple = triples.find(t => t.includes('vocab#returns'));
    expect(returnsTriple).toBeDefined();
  });
});

describe('batchTriples', () => {
  it('uses default batch size of 25', () => {
    const triples = Array.from({ length: 60 }, (_, i) => `<urn:s:${i}> <urn:p> <urn:o> .`);
    const batches = batchTriples(triples);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(25);
    expect(batches[1].length).toBe(25);
    expect(batches[2].length).toBe(10);
  });

  it('splits with custom batch size', () => {
    const triples = Array.from({ length: 350 }, (_, i) => `<urn:s:${i}> <urn:p> <urn:o> .`);
    const batches = batchTriples(triples, 100);
    expect(batches.length).toBe(4);
    expect(batches[0].length).toBe(100);
    expect(batches[3].length).toBe(50);
  });

  it('returns single batch for small input', () => {
    const triples = ['<urn:a> <urn:b> <urn:c> .'];
    const batches = batchTriples(triples);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1);
  });

  it('returns empty array for empty input', () => {
    const batches = batchTriples([]);
    expect(batches.length).toBe(0);
  });
});

describe('pushSymbolTriples', () => {
  it('reports partial failure with retry hint', async () => {
    let insertCount = 0;
    const mockAdapter = {
      sparqlUpdate: async (query: string) => {
        if (query.startsWith('DELETE')) return;
        insertCount++;
        // Fail every 2nd INSERT batch
        if (insertCount % 2 === 0) throw new Error('Oxigraph parse error');
      },
    };

    const result = makeResult({
      classes: Array.from({ length: 5 }, (_, i) => ({
        name: `Class${i}`,
        filePath: `src/c${i}`,
        baseClass: null,
        interfaces: [],
        methods: [{ name: 'run', returnType: 'void', parameters: [] }],
        isAbstract: false,
      })),
    });

    const pushResult = await pushSymbolTriples(mockAdapter, 'http://test/graph', result);

    expect(pushResult.triplesInserted).toBeGreaterThan(0);
    expect(pushResult.batchesFailed).toBeGreaterThan(0);
    expect(pushResult.triplesFailed).toBeGreaterThan(0);
    expect(pushResult.errors.length).toBeGreaterThan(0);
    expect(pushResult.errors[0]).toContain('Oxigraph parse error');
    expect(pushResult.retryHint).toBeTruthy();
    expect(pushResult.retryHint).toContain('Re-run context_scan');
  });

  it('reports full success with no retry hint', async () => {
    const mockAdapter = {
      sparqlUpdate: async () => {},
    };

    const result = makeResult({
      functions: [{ name: 'foo', filePath: 'src/foo', returnType: 'void', parameters: [], isExported: true }],
    });

    const pushResult = await pushSymbolTriples(mockAdapter, 'http://test/graph', result);

    expect(pushResult.triplesInserted).toBeGreaterThan(0);
    expect(pushResult.triplesFailed).toBe(0);
    expect(pushResult.batchesFailed).toBe(0);
    expect(pushResult.errors).toEqual([]);
    expect(pushResult.retryHint).toBeNull();
  });
});
