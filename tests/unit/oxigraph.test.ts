import { describe, it, expect } from 'vitest';
import { hasGraphScope, autoScopeQuery } from '../../src/lib/sparql-utils.js';

describe('hasGraphScope', () => {
  it('returns true for query containing GRAPH keyword', () => {
    const query = 'SELECT * WHERE { GRAPH <http://example.org/g> { ?s ?p ?o } }';
    expect(hasGraphScope(query)).toBe(true);
  });

  it('returns true for query containing FROM NAMED', () => {
    const query = 'SELECT * FROM NAMED <http://example.org/g> WHERE { ?s ?p ?o }';
    expect(hasGraphScope(query)).toBe(true);
  });

  it('returns true for query containing FROM <', () => {
    const query = 'SELECT * FROM <http://example.org/g> WHERE { ?s ?p ?o }';
    expect(hasGraphScope(query)).toBe(true);
  });

  it('returns false for simple SELECT without graph scope', () => {
    const query = 'SELECT * WHERE { ?s ?p ?o }';
    expect(hasGraphScope(query)).toBe(false);
  });
});

describe('autoScopeQuery', () => {
  const graphUri = 'http://example.org/mygraph';

  it('wraps a standard WHERE clause', () => {
    const query = 'SELECT * WHERE { ?s ?p ?o }';
    const scoped = autoScopeQuery(query, graphUri);
    expect(scoped).not.toBeNull();
    expect(scoped).toContain(`GRAPH <${graphUri}>`);
    expect(scoped).toContain('?s ?p ?o');
  });

  it('handles shorthand queries (no WHERE keyword)', () => {
    const query = 'SELECT * { ?s ?p ?o }';
    const scoped = autoScopeQuery(query, graphUri);
    expect(scoped).not.toBeNull();
    expect(scoped).toContain(`GRAPH <${graphUri}>`);
  });

  it('returns null for queries with no braces', () => {
    const query = 'DESCRIBE <http://example.org/Alice>';
    const result = autoScopeQuery(query, graphUri);
    expect(result).toBeNull();
  });
});
