import { WELL_KNOWN_PREFIXES } from './sparql-utils.js';
import type { SchemaRelations } from './store-adapter.js';

export interface VisNode {
  id: string;
  label: string;
  type?: 'class' | 'property' | 'instance' | 'bnode';
}

export interface VisEdge {
  source: string;
  target: string;
  label: string;
}

export interface VisGraph {
  nodes: VisNode[];
  edges: VisEdge[];
  prefixes: Record<string, string>;
}

export function shortenUri(uri: string, prefixes: Record<string, string>): string {
  // Check provided prefixes first (prefix -> namespace mapping)
  for (const [prefix, ns] of Object.entries(prefixes)) {
    if (uri.startsWith(ns)) {
      return `${prefix}:${uri.slice(ns.length)}`;
    }
  }
  // Check well-known prefixes (namespace -> prefix mapping)
  for (const [ns, prefix] of Object.entries(WELL_KNOWN_PREFIXES)) {
    if (uri.startsWith(ns)) {
      return `${prefix}:${uri.slice(ns.length)}`;
    }
  }
  // Fallback: extract local name after # or last /
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx !== -1) return uri.slice(hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  if (slashIdx !== -1) return uri.slice(slashIdx + 1);
  return uri;
}

function makeClassNode(uri: string, prefixes: Record<string, string>): VisNode {
  const isBnode = uri.startsWith('_:');
  return { id: uri, label: isBnode ? '[]' : shortenUri(uri, prefixes), type: isBnode ? 'bnode' : 'class' };
}

function ensureNode(nodeMap: Map<string, VisNode>, uri: string, prefixes: Record<string, string>, type: VisNode['type'] = 'class'): void {
  if (!nodeMap.has(uri)) {
    nodeMap.set(uri, type === 'property'
      ? { id: uri, label: shortenUri(uri, prefixes), type: 'property' }
      : makeClassNode(uri, prefixes));
  }
}

export function fromSchemaData(
  overview: { prefixes: Record<string, string>; classes: string[]; properties: string[] },
  relations: SchemaRelations,
): VisGraph {
  const prefixes = { ...overview.prefixes };
  const nodeMap = new Map<string, VisNode>();
  const edges: VisEdge[] = [];

  for (const cls of overview.classes) {
    ensureNode(nodeMap, cls, prefixes);
  }

  for (const { child, parent } of relations.subClassOf) {
    ensureNode(nodeMap, child, prefixes);
    ensureNode(nodeMap, parent, prefixes);
    edges.push({ source: child, target: parent, label: 'subClassOf' });
  }

  for (const { property, domain, range } of relations.domainRange) {
    ensureNode(nodeMap, property, prefixes, 'property');
    if (domain) {
      ensureNode(nodeMap, domain, prefixes);
      edges.push({ source: property, target: domain, label: 'domain' });
    }
    if (range) {
      ensureNode(nodeMap, range, prefixes);
      edges.push({ source: property, target: range, label: 'range' });
    }
  }

  return {
    nodes: [...nodeMap.values()],
    edges,
    prefixes,
  };
}

function mermaidId(uri: string): string {
  return uri.replace(/[^a-zA-Z0-9_]/g, '_');
}

const MERMAID_NODE_LIMIT = 150;
const DOT_NODE_LIMIT = 500;

export function toMermaid(graph: VisGraph): string {
  if (graph.nodes.length === 0) {
    return 'graph TD\n  %% Empty graph';
  }

  const lines: string[] = ['graph TD'];
  const truncated = graph.nodes.length > MERMAID_NODE_LIMIT;
  const nodes = truncated ? graph.nodes.slice(0, MERMAID_NODE_LIMIT) : graph.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));

  if (truncated) {
    lines.push(`  %% WARNING: Truncated to ${MERMAID_NODE_LIMIT} of ${graph.nodes.length} nodes`);
  }

  // Node definitions with shapes based on type
  for (const node of nodes) {
    const id = mermaidId(node.id);
    const label = node.label.replace(/"/g, '#quot;');
    switch (node.type) {
      case 'class':
        lines.push(`  ${id}["${label}"]`);
        break;
      case 'property':
        lines.push(`  ${id}(["${label}"])`);
        break;
      case 'bnode':
        lines.push(`  ${id}{"${label}"}`);
        break;
      default:
        lines.push(`  ${id}["${label}"]`);
    }
  }

  // Edges (only for nodes in the truncated set)
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const src = mermaidId(edge.source);
    const tgt = mermaidId(edge.target);
    const label = edge.label.replace(/"/g, '#quot;');
    lines.push(`  ${src} -->|"${label}"| ${tgt}`);
  }

  return lines.join('\n');
}

export function toDot(graph: VisGraph): string {
  if (graph.nodes.length === 0) {
    return 'digraph G {\n  // Empty graph\n}';
  }

  const lines: string[] = ['digraph G {', '  rankdir=TB;', '  node [fontname="Helvetica"];'];
  const truncated = graph.nodes.length > DOT_NODE_LIMIT;
  const nodes = truncated ? graph.nodes.slice(0, DOT_NODE_LIMIT) : graph.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));

  if (truncated) {
    lines.push(`  // WARNING: Truncated to ${DOT_NODE_LIMIT} of ${graph.nodes.length} nodes`);
  }

  // Node definitions with shapes based on type
  for (const node of nodes) {
    const id = mermaidId(node.id); // reuse sanitizer
    const label = node.label.replace(/"/g, '\\"');
    switch (node.type) {
      case 'class':
        lines.push(`  ${id} [label="${label}" shape=box];`);
        break;
      case 'property':
        lines.push(`  ${id} [label="${label}" shape=ellipse];`);
        break;
      case 'bnode':
        lines.push(`  ${id} [label="${label}" shape=diamond];`);
        break;
      default:
        lines.push(`  ${id} [label="${label}" shape=box];`);
    }
  }

  // Edges
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const src = mermaidId(edge.source);
    const tgt = mermaidId(edge.target);
    const label = edge.label.replace(/"/g, '\\"');
    lines.push(`  ${src} -> ${tgt} [label="${label}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}
