import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, resolveGraphUri } from './config.js';
import { createReadyAdapter } from './store-factory.js';
import type { OpenTologyConfig } from './config.js';
import type { StoreAdapter } from './store-adapter.js';

function html(config: OpenTologyConfig): string {
  const projectId = config.projectId;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenTology — ${projectId}</title>
  <script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #ffffff; color: #1f2328; }
    #app { display: flex; height: 100vh; }
    #sidebar { width: 320px; background: #f6f8fa; border-right: 1px solid #d1d9e0; display: flex; flex-direction: column; overflow: hidden; }
    #sidebar h1 { padding: 16px; font-size: 16px; border-bottom: 1px solid #d1d9e0; color: #0550ae; }
    #graph-list { padding: 8px 16px; border-bottom: 1px solid #d1d9e0; }
    #graph-list select { width: 100%; padding: 6px 8px; background: #ffffff; color: #1f2328; border: 1px solid #d1d9e0; border-radius: 6px; font-size: 13px; }
    #query-box { padding: 12px 16px; border-bottom: 1px solid #d1d9e0; }
    #query-box textarea { width: 100%; height: 80px; padding: 8px; background: #ffffff; color: #1f2328; border: 1px solid #d1d9e0; border-radius: 6px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; resize: vertical; }
    #query-box button { margin-top: 8px; padding: 6px 16px; background: #1a7f37; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
    #query-box button:hover { background: #218739; }
    #details { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 13px; }
    #details h3 { color: #0550ae; margin-bottom: 8px; }
    #details table { width: 100%; border-collapse: collapse; }
    #details td { padding: 4px 6px; border-bottom: 1px solid #d1d9e0; word-break: break-all; }
    #details td:first-child { color: #656d76; width: 90px; }
    #results-table { display: none; padding: 12px 16px; overflow: auto; max-height: 300px; border-bottom: 1px solid #d1d9e0; }
    #results-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #results-table th { text-align: left; padding: 6px 8px; background: #eef1f5; border-bottom: 2px solid #d1d9e0; color: #0550ae; position: sticky; top: 0; }
    #results-table td { padding: 4px 8px; border-bottom: 1px solid #d1d9e0; word-break: break-all; }
    #results-table tr:hover td { background: #f0f4ff; }
    #network { flex: 1; }
    .legend { position: absolute; bottom: 16px; right: 16px; background: #f6f8faee; padding: 12px 16px; border-radius: 8px; border: 1px solid #d1d9e0; font-size: 12px; color: #1f2328; }
    .legend-item { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
    .stats { padding: 8px 16px; border-bottom: 1px solid #d1d9e0; font-size: 12px; color: #656d76; }
  </style>
</head>
<body>
  <div id="app">
    <div id="sidebar">
      <h1>OpenTology — ${projectId}</h1>
      <div id="graph-list">
        <select id="graphSelect"><option value="">Loading graphs...</option></select>
      </div>
      <div class="stats" id="stats"></div>
      <div id="query-box">
        <textarea id="sparql" placeholder="SPARQL query...">SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100</textarea>
        <button onclick="runQuery()">Run Query</button>
      </div>
      <div id="results-table"></div>
      <div id="details"></div>
    </div>
    <div id="network" style="position: relative;">
      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:#0550ae"></div> Class</div>
        <div class="legend-item"><div class="legend-dot" style="background:#cf222e"></div> Instance</div>
        <div class="legend-item"><div class="legend-dot" style="background:#1a7f37"></div> Property</div>
        <div class="legend-item"><div class="legend-dot" style="background:#ffffff;border:1px solid #d1d9e0"></div> Literal</div>
      </div>
    </div>
  </div>
  <script>
    const COLORS = {
      class: '#0550ae', instance: '#cf222e', property: '#1a7f37',
      literal: '#ffffff', edge: '#d1d9e0', edgeLabel: '#656d76'
    };
    const PREFIXES = {
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
      'http://www.w3.org/2000/01/rdf-schema#': 'rdfs:',
      'http://www.w3.org/2002/07/owl#': 'owl:',
      'http://www.w3.org/2001/XMLSchema#': 'xsd:',
      'https://opentology.dev/vocab#': 'otx:',
    };

    function shorten(uri) {
      if (!uri) return '';
      for (const [full, prefix] of Object.entries(PREFIXES)) {
        if (uri.startsWith(full)) return prefix + uri.slice(full.length);
      }
      const hash = uri.lastIndexOf('#');
      if (hash > 0) return uri.slice(hash + 1);
      const slash = uri.lastIndexOf('/');
      if (slash > 0) return uri.slice(slash + 1);
      return uri;
    }

    let network, nodesDS, edgesDS, classSet = new Set();

    async function init() {
      const gs = await fetch('/api/graphs').then(r => r.json());
      const sel = document.getElementById('graphSelect');
      sel.innerHTML = '';
      for (const g of gs) {
        sel.innerHTML += '<option value="' + g.uri + '">' + g.name + ' (' + g.triples + ')</option>';
      }
      sel.onchange = () => loadGraph(sel.value);

      // Load schema to know which URIs are classes
      try {
        const schema = await fetch('/api/schema').then(r => r.json());
        (schema.classes || []).forEach(c => classSet.add(c));
      } catch {}

      nodesDS = new vis.DataSet();
      edgesDS = new vis.DataSet();
      network = new vis.Network(document.getElementById('network'), { nodes: nodesDS, edges: edgesDS }, {
        physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -80, springLength: 120 } },
        nodes: { shape: 'dot', font: { color: '#1f2328', size: 12 }, borderWidth: 0 },
        edges: { arrows: 'to', color: { color: COLORS.edge, highlight: '#0550ae' }, font: { color: COLORS.edgeLabel, size: 10, strokeWidth: 0 }, smooth: { type: 'curvedCW', roundness: 0.15 } },
        interaction: { hover: true, tooltipDelay: 100 },
      });
      network.on('click', params => {
        if (params.nodes.length) showNodeDetails(params.nodes[0]);
      });
      loadGraph(sel.value);
    }

    async function loadGraph(graphUri) {
      const q = graphUri
        ? 'SELECT ?s ?p ?o WHERE { GRAPH <' + graphUri + '> { ?s ?p ?o } } LIMIT 500'
        : 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 500';
      document.getElementById('sparql').value = q;
      await runQuery();
    }

    async function runQuery() {
      const sparql = document.getElementById('sparql').value;
      const res = await fetch('/api/query?sparql=' + encodeURIComponent(sparql) + '&raw=true').then(r => r.json());
      const bindings = res.results?.bindings || [];
      const vars = res.head?.vars || [];
      const isSPO = vars.includes('s') && vars.includes('p') && vars.includes('o');
      const tableEl = document.getElementById('results-table');
      if (isSPO) {
        tableEl.style.display = 'none';
        renderGraph(bindings);
      } else {
        renderTable(vars, bindings);
        nodesDS.clear(); edgesDS.clear();
      }
      document.getElementById('stats').textContent = bindings.length + ' results';
    }

    function renderTable(vars, bindings) {
      const tableEl = document.getElementById('results-table');
      if (!bindings.length) {
        tableEl.style.display = 'block';
        tableEl.innerHTML = '<p style="color:#656d76">No results</p>';
        return;
      }
      let h = '<table><thead><tr>';
      for (const v of vars) h += '<th>' + v + '</th>';
      h += '</tr></thead><tbody>';
      for (const b of bindings) {
        h += '<tr>';
        for (const v of vars) {
          const cell = b[v];
          const val = cell ? (cell.type === 'uri' ? shorten(cell.value) : cell.value) : '';
          h += '<td>' + val + '</td>';
        }
        h += '</tr>';
      }
      h += '</tbody></table>';
      tableEl.style.display = 'block';
      tableEl.innerHTML = h;
    }

    function nodeColor(uri) {
      if (classSet.has(uri)) return COLORS.class;
      if (uri.startsWith('http://www.w3.org/') || uri.startsWith('https://opentology.dev/vocab#')) return COLORS.property;
      return COLORS.instance;
    }

    function renderGraph(bindings) {
      const nodes = new Map();
      const edges = [];
      for (const b of bindings) {
        const vars = Object.keys(b);
        if (vars.includes('s') && vars.includes('p') && vars.includes('o')) {
          const s = b.s, p = b.p, o = b.o;
          if (!nodes.has(s.value)) {
            nodes.set(s.value, { id: s.value, label: shorten(s.value), color: nodeColor(s.value), size: 14, title: s.value });
          }
          if (o.type === 'uri' || o.type === 'bnode') {
            if (!nodes.has(o.value)) {
              nodes.set(o.value, { id: o.value, label: shorten(o.value), color: nodeColor(o.value), size: 12, title: o.value });
            }
            edges.push({ from: s.value, to: o.value, label: shorten(p.value), title: p.value });
          } else {
            const litId = s.value + '|' + p.value + '|' + o.value;
            const litLabel = o.value.length > 40 ? o.value.slice(0, 40) + '...' : o.value;
            if (!nodes.has(litId)) {
              nodes.set(litId, { id: litId, label: litLabel, color: { background: COLORS.literal, border: '#d1d9e0' }, borderWidth: 1, size: 8, shape: 'box', font: { size: 10, color: '#1f2328' }, title: o.value });
            }
            edges.push({ from: s.value, to: litId, label: shorten(p.value), title: p.value });
          }
        }
      }
      nodesDS.clear(); edgesDS.clear();
      nodesDS.add([...nodes.values()]);
      edgesDS.add(edges);
      network.fit();
    }

    async function showNodeDetails(nodeId) {
      const q = 'SELECT ?p ?o WHERE { <' + nodeId + '> ?p ?o }';
      const res = await fetch('/api/query?sparql=' + encodeURIComponent(q) + '&raw=true').then(r => r.json());
      const bindings = res.results?.bindings || [];
      let html = '<h3>' + shorten(nodeId) + '</h3><table>';
      for (const b of bindings) {
        html += '<tr><td>' + shorten(b.p.value) + '</td><td>' + (b.o.type === 'uri' ? shorten(b.o.value) : b.o.value) + '</td></tr>';
      }
      html += '</table>';
      document.getElementById('details').innerHTML = html;
    }

    init();
  </script>
</body>
</html>`;
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function json(res: ServerResponse, data: unknown): void {
  cors(res);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export interface GraphServerOptions {
  port?: number;
}

export async function startGraphServer(
  opts: GraphServerOptions = {},
): Promise<{ port: number; close: () => void }> {
  const config = loadConfig();
  const adapter = await createReadyAdapter(config);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      cors(res);
      res.end();
      return;
    }

    try {
      if (path === '/' || path === '/index.html') {
        cors(res);
        res.setHeader('Content-Type', 'text/html');
        res.end(html(config));
        return;
      }

      if (path === '/api/graphs') {
        const graphs = config.graphs ?? {};
        const result = [];
        for (const [name, uri] of Object.entries(graphs)) {
          const triples = await adapter.getGraphTripleCount(uri).catch(() => 0);
          result.push({ name, uri, triples });
        }
        // Also include default graph
        const defaultTriples = await adapter.getGraphTripleCount(config.graphUri).catch(() => 0);
        result.unshift({ name: 'default', uri: config.graphUri, triples: defaultTriples });
        json(res, result);
        return;
      }

      if (path === '/api/schema') {
        const graphUri = url.searchParams.get('graphUri') ?? config.graphUri;
        const overview = await adapter.getSchemaOverview(graphUri);
        json(res, overview);
        return;
      }

      if (path === '/api/query') {
        const sparql = url.searchParams.get('sparql');
        if (!sparql) {
          res.statusCode = 400;
          json(res, { error: 'Missing sparql parameter' });
          return;
        }
        const raw = url.searchParams.get('raw') === 'true';
        let query = sparql;
        if (!raw) {
          const { hasGraphScope, autoScopeQuery } = await import('./sparql-utils.js');
          if (!hasGraphScope(query)) {
            const scoped = autoScopeQuery(query, config.graphUri);
            if (scoped) query = scoped;
          }
        }
        const result = await adapter.sparqlQuery(query);
        json(res, result);
        return;
      }

      res.statusCode = 404;
      json(res, { error: 'Not found' });
    } catch (err) {
      res.statusCode = 500;
      json(res, { error: (err as Error).message });
    }
  });

  const port = opts.port ?? 0; // 0 = auto-assign
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const assignedPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: assignedPort,
        close: () => server.close(),
      });
    });
  });
}
