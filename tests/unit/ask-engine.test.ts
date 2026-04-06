import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolvePredicate,
  validateContext,
  bindTemplate,
  evaluate,
  recordEvaluation,
  ask,
} from '../../src/lib/ask-engine.js';
import type { StoreAdapter, SparqlResults } from '../../src/lib/store-adapter.js';

// ── Mock adapter ──

function createMockAdapter(overrides: Partial<StoreAdapter> = {}): StoreAdapter {
  return {
    sparqlQuery: vi.fn().mockResolvedValue({ head: { vars: [] }, results: { bindings: [] } }),
    askQuery: vi.fn().mockResolvedValue(false),
    sparqlUpdate: vi.fn().mockResolvedValue(undefined),
    constructQuery: vi.fn().mockResolvedValue(''),
    insertTurtle: vi.fn().mockResolvedValue(undefined),
    dropGraph: vi.fn().mockResolvedValue(undefined),
    deleteTriples: vi.fn().mockResolvedValue(undefined),
    getGraphTripleCount: vi.fn().mockResolvedValue(0),
    exportGraph: vi.fn().mockResolvedValue(''),
    diffGraph: vi.fn().mockResolvedValue({ added: [], removed: [], unchanged: 0, addedCount: 0, removedCount: 0, truncated: false }),
    getSchemaOverview: vi.fn().mockResolvedValue({ prefixes: {}, classes: [], properties: [], tripleCount: 0 }),
    getClassDetails: vi.fn().mockResolvedValue({ classUri: '', instanceCount: 0, properties: [], sampleTriples: [] }),
    getSchemaRelations: vi.fn().mockResolvedValue({ subClassOf: [], domainRange: [] }),
    ...overrides,
  };
}

const GRAPH_URI = 'https://opentology.dev/test/context';

// ── resolvePredicate ──

describe('resolvePredicate', () => {
  it('returns null when no predicate found', async () => {
    const adapter = createMockAdapter();
    const result = await resolvePredicate(adapter, 'Unknown.pred', GRAPH_URI);
    expect(result).toBeNull();
  });

  it('resolves predicate with title and params', async () => {
    const bindings = [
      {
        uri: { type: 'uri', value: 'urn:predicate:Module.hasOpenIssue' },
        title: { type: 'literal', value: 'Module.hasOpenIssue' },
        template: { type: 'literal', value: 'ASK { ?s a otx:Issue }' },
        param: { type: 'literal', value: 'module' },
      },
    ];
    const adapter = createMockAdapter({
      sparqlQuery: vi.fn().mockResolvedValue({
        head: { vars: ['uri', 'title', 'template', 'param'] },
        results: { bindings },
      }),
    });

    const result = await resolvePredicate(adapter, 'Module.hasOpenIssue', GRAPH_URI);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Module.hasOpenIssue');
    expect(result!.requiredParams).toEqual(['module']);
    expect(result!.sparqlTemplate).toBe('ASK { ?s a otx:Issue }');
  });

  it('deduplicates required params', async () => {
    const bindings = [
      {
        uri: { type: 'uri', value: 'urn:predicate:Test' },
        title: { type: 'literal', value: 'Test' },
        template: { type: 'literal', value: 'ASK { }' },
        param: { type: 'literal', value: 'x' },
      },
      {
        uri: { type: 'uri', value: 'urn:predicate:Test' },
        title: { type: 'literal', value: 'Test' },
        template: { type: 'literal', value: 'ASK { }' },
        param: { type: 'literal', value: 'x' },
      },
    ];
    const adapter = createMockAdapter({
      sparqlQuery: vi.fn().mockResolvedValue({
        head: { vars: ['uri', 'title', 'template', 'param'] },
        results: { bindings },
      }),
    });

    const result = await resolvePredicate(adapter, 'Test', GRAPH_URI);
    expect(result!.requiredParams).toEqual(['x']);
  });
});

// ── validateContext ──

describe('validateContext', () => {
  const predicate = {
    uri: 'urn:predicate:Test',
    title: 'Test',
    sparqlTemplate: '',
    requiredParams: ['module', 'status'],
  };

  it('returns empty array when all params provided', () => {
    expect(validateContext(predicate, { module: 'a', status: 'open' })).toEqual([]);
  });

  it('returns missing params', () => {
    expect(validateContext(predicate, { module: 'a' })).toEqual(['status']);
  });

  it('returns all params when none provided', () => {
    expect(validateContext(predicate, {})).toEqual(['module', 'status']);
  });
});

// ── bindTemplate ──

describe('bindTemplate', () => {
  it('replaces graphUri and context params', () => {
    const template = 'ASK { GRAPH <{{graphUri}}> { ?s otx:relatedTo <urn:module:{{module}}> } }';
    const result = bindTemplate(template, { module: 'src/lib/foo.ts' }, GRAPH_URI);
    expect(result).toBe(`ASK { GRAPH <${GRAPH_URI}> { ?s otx:relatedTo <urn:module:src/lib/foo.ts> } }`);
  });

  it('replaces multiple occurrences', () => {
    const template = '{{x}} and {{x}}';
    expect(bindTemplate(template, { x: 'val' }, GRAPH_URI)).toBe('val and val');
  });
});

// ── evaluate ──

describe('evaluate', () => {
  it('delegates ASK queries to askQuery', async () => {
    const adapter = createMockAdapter({ askQuery: vi.fn().mockResolvedValue(true) });
    const result = await evaluate(adapter, 'ASK { ?s ?p ?o }');
    expect(result.answer).toBe(true);
    expect(adapter.askQuery).toHaveBeenCalledWith('ASK { ?s ?p ?o }');
  });

  it('handles ASK with PREFIX', async () => {
    const adapter = createMockAdapter({ askQuery: vi.fn().mockResolvedValue(false) });
    const sparql = 'PREFIX otx: <https://opentology.dev/vocab#>\nASK { ?s a otx:Issue }';
    await evaluate(adapter, sparql);
    expect(adapter.askQuery).toHaveBeenCalled();
  });

  it('handles SELECT queries — returns true when bindings exist', async () => {
    const adapter = createMockAdapter({
      sparqlQuery: vi.fn().mockResolvedValue({
        head: { vars: ['s'] },
        results: { bindings: [{ s: { type: 'uri', value: 'urn:test' } }] },
      }),
    });
    const result = await evaluate(adapter, 'SELECT ?s WHERE { ?s ?p ?o }');
    expect(result.answer).toBe(true);
    expect(result.bindings).toEqual([{ s: 'urn:test' }]);
  });

  it('handles SELECT queries — returns false when empty', async () => {
    const adapter = createMockAdapter();
    const result = await evaluate(adapter, 'SELECT ?s WHERE { ?s ?p ?o }');
    expect(result.answer).toBe(false);
    expect(result.bindings).toBeUndefined();
  });
});

// ── recordEvaluation ──

describe('recordEvaluation', () => {
  it('inserts evaluation turtle with correct structure', async () => {
    const adapter = createMockAdapter();
    const uri = await recordEvaluation(
      adapter,
      GRAPH_URI,
      'urn:predicate:Test',
      { module: 'foo.ts' },
      true,
    );

    expect(uri).toMatch(/^urn:evaluation:\d{4}-\d{2}-\d{2}-\d+$/);
    expect(adapter.insertTurtle).toHaveBeenCalledOnce();

    const turtle = (adapter.insertTurtle as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(turtle).toContain('a otx:Evaluation');
    expect(turtle).toContain('otx:predicate <urn:predicate:Test>');
    expect(turtle).toContain('otx:result "true"');
  });

  it('includes session link when provided', async () => {
    const adapter = createMockAdapter();
    await recordEvaluation(
      adapter,
      GRAPH_URI,
      'urn:predicate:Test',
      {},
      false,
      'urn:session:2026-04-06',
    );

    const turtle = (adapter.insertTurtle as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(turtle).toContain('otx:createdIn <urn:session:2026-04-06>');
  });
});

// ── ask (integration) ──

describe('ask', () => {
  it('returns null answer for unknown predicate', async () => {
    const adapter = createMockAdapter();
    const result = await ask(adapter, GRAPH_URI, {
      predicate: 'NonExistent',
      context: {},
    });
    expect(result.answer).toBeNull();
    expect(result.reason).toContain('Unknown predicate');
  });

  it('returns null with missing params', async () => {
    const adapter = createMockAdapter({
      sparqlQuery: vi.fn().mockResolvedValue({
        head: { vars: ['uri', 'title', 'template', 'param'] },
        results: {
          bindings: [
            {
              uri: { type: 'uri', value: 'urn:predicate:Test' },
              title: { type: 'literal', value: 'Test' },
              template: { type: 'literal', value: 'ASK { }' },
              param: { type: 'literal', value: 'required_field' },
            },
          ],
        },
      }),
    });

    const result = await ask(adapter, GRAPH_URI, {
      predicate: 'Test',
      context: {},
    });
    expect(result.answer).toBeNull();
    expect(result.missing).toEqual(['required_field']);
  });

  it('evaluates ASK predicate and records result', async () => {
    // First call: resolvePredicate (sparqlQuery), second call: not used for ASK
    let callCount = 0;
    const adapter = createMockAdapter({
      sparqlQuery: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // resolvePredicate
          return {
            head: { vars: ['uri', 'title', 'template', 'param'] },
            results: {
              bindings: [
                {
                  uri: { type: 'uri', value: 'urn:predicate:Module.hasOpenIssue' },
                  title: { type: 'literal', value: 'Module.hasOpenIssue' },
                  template: { type: 'literal', value: 'ASK { GRAPH <{{graphUri}}> { ?i a <https://opentology.dev/vocab#Issue> } }' },
                  param: { type: 'literal', value: 'module' },
                },
              ],
            },
          };
        }
        return { head: { vars: [] }, results: { bindings: [] } };
      }),
      askQuery: vi.fn().mockResolvedValue(true),
    });

    const result = await ask(adapter, GRAPH_URI, {
      predicate: 'Module.hasOpenIssue',
      context: { module: 'src/lib/foo.ts' },
    });

    expect(result.answer).toBe(true);
    expect(result.evaluationUri).toMatch(/^urn:evaluation:/);
    expect(adapter.insertTurtle).toHaveBeenCalledOnce();
  });

  it('skips recording when record=false', async () => {
    const adapter = createMockAdapter({
      sparqlQuery: vi.fn().mockResolvedValue({
        head: { vars: ['uri', 'title', 'template'] },
        results: {
          bindings: [
            {
              uri: { type: 'uri', value: 'urn:predicate:Simple' },
              title: { type: 'literal', value: 'Simple' },
              template: { type: 'literal', value: 'ASK { ?s ?p ?o }' },
            },
          ],
        },
      }),
      askQuery: vi.fn().mockResolvedValue(false),
    });

    const result = await ask(adapter, GRAPH_URI, {
      predicate: 'Simple',
      context: {},
      record: false,
    });

    expect(result.answer).toBe(false);
    expect(result.evaluationUri).toBeUndefined();
    expect(adapter.insertTurtle).not.toHaveBeenCalled();
  });
});
