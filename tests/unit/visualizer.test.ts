import { describe, it, expect } from 'vitest';
import {
  shortenUri,
  fromSchemaData,
  toMermaid,
  toDot,
  type VisGraph,
  type VisNode,
} from '../../src/lib/visualizer.js';
import type { SchemaRelations } from '../../src/lib/store-adapter.js';

// ── shortenUri ───────────────────────────────────────────────────────

describe('shortenUri', () => {
  it('shortens well-known prefixes', () => {
    expect(shortenUri('http://www.w3.org/2000/01/rdf-schema#Class', {})).toBe('rdfs:Class');
    expect(shortenUri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', {})).toBe('rdf:type');
    expect(shortenUri('http://schema.org/Person', {})).toBe('schema:Person');
  });

  it('shortens with provided prefixes (priority over well-known)', () => {
    const prefixes = { ex: 'http://example.org/' };
    expect(shortenUri('http://example.org/Foo', prefixes)).toBe('ex:Foo');
  });

  it('falls back to local name after # for unknown URIs', () => {
    expect(shortenUri('http://unknown.org/ontology#MyClass', {})).toBe('MyClass');
  });

  it('falls back to local name after / for unknown URIs', () => {
    expect(shortenUri('http://unknown.org/path/MyClass', {})).toBe('MyClass');
  });

  it('returns full URI if no # or / separator found', () => {
    expect(shortenUri('urn:something', {})).toBe('urn:something');
  });
});

// ── fromSchemaData ───────────────────────────────────────────────────

describe('fromSchemaData', () => {
  it('produces correct nodes for classes', () => {
    const overview = {
      prefixes: { ex: 'http://example.org/' },
      classes: ['http://example.org/Person', 'http://example.org/Animal'],
      properties: [],
    };
    const relations: SchemaRelations = { subClassOf: [], domainRange: [] };

    const graph = fromSchemaData(overview, relations);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toEqual({
      id: 'http://example.org/Person',
      label: 'ex:Person',
      type: 'class',
    });
    expect(graph.nodes[1]).toEqual({
      id: 'http://example.org/Animal',
      label: 'ex:Animal',
      type: 'class',
    });
  });

  it('produces correct edges for subClassOf', () => {
    const overview = {
      prefixes: {},
      classes: ['http://example.org/Dog', 'http://example.org/Animal'],
      properties: [],
    };
    const relations: SchemaRelations = {
      subClassOf: [{ child: 'http://example.org/Dog', parent: 'http://example.org/Animal' }],
      domainRange: [],
    };

    const graph = fromSchemaData(overview, relations);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      source: 'http://example.org/Dog',
      target: 'http://example.org/Animal',
      label: 'subClassOf',
    });
  });

  it('produces correct edges for domainRange', () => {
    const overview = {
      prefixes: {},
      classes: ['http://example.org/Person'],
      properties: ['http://example.org/name'],
    };
    const relations: SchemaRelations = {
      subClassOf: [],
      domainRange: [
        {
          property: 'http://example.org/name',
          domain: 'http://example.org/Person',
          range: 'http://www.w3.org/2001/XMLSchema#string',
        },
      ],
    };

    const graph = fromSchemaData(overview, relations);
    const domainEdge = graph.edges.find((e) => e.label === 'domain');
    const rangeEdge = graph.edges.find((e) => e.label === 'range');
    expect(domainEdge).toBeDefined();
    expect(domainEdge!.source).toBe('http://example.org/name');
    expect(domainEdge!.target).toBe('http://example.org/Person');
    expect(rangeEdge).toBeDefined();
    expect(rangeEdge!.target).toBe('http://www.w3.org/2001/XMLSchema#string');
  });

  it('returns empty VisGraph for empty input', () => {
    const overview = { prefixes: {}, classes: [], properties: [] };
    const relations: SchemaRelations = { subClassOf: [], domainRange: [] };

    const graph = fromSchemaData(overview, relations);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('handles blank nodes with bnode type', () => {
    const overview = {
      prefixes: {},
      classes: ['_:b0'],
      properties: [],
    };
    const relations: SchemaRelations = { subClassOf: [], domainRange: [] };

    const graph = fromSchemaData(overview, relations);
    expect(graph.nodes[0].type).toBe('bnode');
  });

  it('creates property nodes from domainRange', () => {
    const overview = { prefixes: {}, classes: [], properties: [] };
    const relations: SchemaRelations = {
      subClassOf: [],
      domainRange: [{ property: 'http://example.org/knows', domain: 'http://example.org/Person' }],
    };

    const graph = fromSchemaData(overview, relations);
    const propNode = graph.nodes.find((n) => n.id === 'http://example.org/knows');
    expect(propNode).toBeDefined();
    expect(propNode!.type).toBe('property');
  });
});

// ── toMermaid ────────────────────────────────────────────────────────

describe('toMermaid', () => {
  it('produces valid Mermaid syntax with graph TD header', () => {
    const graph: VisGraph = {
      nodes: [
        { id: 'http://ex.org/A', label: 'A', type: 'class' },
        { id: 'http://ex.org/B', label: 'B', type: 'class' },
      ],
      edges: [{ source: 'http://ex.org/A', target: 'http://ex.org/B', label: 'subClassOf' }],
      prefixes: {},
    };

    const result = toMermaid(graph);
    expect(result).toContain('graph TD');
    expect(result).toContain('http___ex_org_A["A"]');
    expect(result).toContain('http___ex_org_B["B"]');
    expect(result).toContain('-->|"subClassOf"|');
  });

  it('produces empty diagram for empty graph', () => {
    const graph: VisGraph = { nodes: [], edges: [], prefixes: {} };
    const result = toMermaid(graph);
    expect(result).toContain('graph TD');
    expect(result).toContain('Empty graph');
  });

  it('uses different shapes for node types', () => {
    const graph: VisGraph = {
      nodes: [
        { id: 'cls', label: 'Cls', type: 'class' },
        { id: 'prop', label: 'Prop', type: 'property' },
        { id: 'bn', label: '[]', type: 'bnode' },
      ],
      edges: [],
      prefixes: {},
    };

    const result = toMermaid(graph);
    expect(result).toContain('cls["Cls"]');       // box for class
    expect(result).toContain('prop(["Prop"])');    // stadium for property
    expect(result).toContain('bn{"[]"}');          // rhombus for bnode
  });

  it('truncates at 150 nodes with warning', () => {
    const nodes: VisNode[] = Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`,
      label: `Node${i}`,
      type: 'class' as const,
    }));
    const graph: VisGraph = { nodes, edges: [], prefixes: {} };

    const result = toMermaid(graph);
    expect(result).toContain('WARNING: Truncated to 150 of 200 nodes');
    // Should only have 150 node definitions (+ header + warning = 152 lines)
    const nodeLines = result.split('\n').filter((l) => l.match(/^\s+n\d+\[/));
    expect(nodeLines).toHaveLength(150);
  });
});

// ── toDot ────────────────────────────────────────────────────────────

describe('toDot', () => {
  it('produces valid DOT syntax with digraph header', () => {
    const graph: VisGraph = {
      nodes: [
        { id: 'http://ex.org/A', label: 'A', type: 'class' },
        { id: 'http://ex.org/B', label: 'B', type: 'class' },
      ],
      edges: [{ source: 'http://ex.org/A', target: 'http://ex.org/B', label: 'subClassOf' }],
      prefixes: {},
    };

    const result = toDot(graph);
    expect(result).toContain('digraph G {');
    expect(result).toContain('shape=box');
    expect(result).toContain('label="subClassOf"');
    expect(result).toContain('}');
  });

  it('produces empty diagram for empty graph', () => {
    const graph: VisGraph = { nodes: [], edges: [], prefixes: {} };
    const result = toDot(graph);
    expect(result).toContain('digraph G {');
    expect(result).toContain('Empty graph');
    expect(result).toContain('}');
  });

  it('uses different shapes for node types', () => {
    const graph: VisGraph = {
      nodes: [
        { id: 'cls', label: 'Cls', type: 'class' },
        { id: 'prop', label: 'Prop', type: 'property' },
        { id: 'bn', label: '[]', type: 'bnode' },
      ],
      edges: [],
      prefixes: {},
    };

    const result = toDot(graph);
    expect(result).toContain('shape=box');      // class
    expect(result).toContain('shape=ellipse');  // property
    expect(result).toContain('shape=diamond');  // bnode
  });

  it('truncates at 500 nodes with warning', () => {
    const nodes: VisNode[] = Array.from({ length: 600 }, (_, i) => ({
      id: `n${i}`,
      label: `Node${i}`,
      type: 'class' as const,
    }));
    const graph: VisGraph = { nodes, edges: [], prefixes: {} };

    const result = toDot(graph);
    expect(result).toContain('WARNING: Truncated to 500 of 600 nodes');
    const nodeLines = result.split('\n').filter((l) => l.match(/^\s+n\d+ \[/));
    expect(nodeLines).toHaveLength(500);
  });
});
