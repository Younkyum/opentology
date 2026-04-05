import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MARKER_BEGIN = '<!-- OPENTOLOGY:CONTEXT:BEGIN -->';
const MARKER_END = '<!-- OPENTOLOGY:CONTEXT:END -->';

export function generateContextSection(projectId: string, graphUri: string): string {
  const contextUri = `${graphUri}/context`;
  const sessionsUri = `${graphUri}/sessions`;

  return `${MARKER_BEGIN}
## Context Management — OpenTology

<principles>
- **Graph first** — query the knowledge graph before reading source files or making assumptions.
- **Always record** — push Session logs at session end; record Knowledge, Decisions, and Issues as they arise.
- **Auto-ingest** — when the user shares a URL or external source, run the ingest protocol automatically.
</principles>

### Graph Structure

| Graph | URI | Purpose |
|-------|-----|---------|
| context | \`${contextUri}\` | Decisions, issues, knowledge, modules, symbols |
| sessions | \`${sessionsUri}\` | Session work logs |

### Ontology (\`otx:\` prefix)

| Class | Description |
|-------|-------------|
| \`otx:Project\` | Project hub info |
| \`otx:Decision\` | Architecture/tech decisions |
| \`otx:Issue\` | Bugs and issues |
| \`otx:Knowledge\` | Reusable knowledge |
| \`otx:Session\` | Session logs |
| \`otx:Pattern\` | Recurring patterns/conventions |
| \`otx:Source\` | External knowledge source (article, paper, code, etc.) |
| \`otx:Module\` | Source file module |
| \`otx:Class\` / \`otx:Interface\` / \`otx:Function\` / \`otx:Method\` | Symbol-level entities (from deep scan) |
| \`otx:MethodCall\` | Call relationship between symbols |

Key properties: \`otx:title\`, \`otx:date\`, \`otx:body\`, \`otx:status\`, \`otx:reason\`, \`otx:nextTodo\`, \`otx:relatedTo\`, \`otx:dependsOn\`, \`otx:definedIn\`, \`otx:callerSymbol\`, \`otx:calleeSymbol\`, \`otx:sourceUrl\`, \`otx:sourceType\`. Full schema: use the \`schema\` tool.

### When to Record

| Trigger | Type | Graph |
|---------|------|-------|
| Architecture/tech decision | \`otx:Decision\` | context |
| Bug/issue resolved | \`otx:Issue\` | context |
| Reusable knowledge | \`otx:Knowledge\` | context |
| Source ingested | \`otx:Source\` | context |
| Session end | \`otx:Session\` | sessions |

### Tools & Workflows

#### Before Working

1. **Query graph** — check for existing decisions, knowledge, issues, and sessions related to your task.
2. **Check impact** — before editing a file, run \`context_impact\` to understand the blast radius (dependents, dependencies, related entities).
3. **Search** — use \`query\` with SPARQL to find anything: \`?s a otx:Decision\`, \`?s a otx:Knowledge\`, \`?s a otx:Module\`, \`?s a otx:MethodCall\`, etc.

\`\`\`sparql
# Context search (replace "keyword" with your search term)
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?type ?title ?body WHERE {
  GRAPH <${contextUri}> {
    { ?s a otx:Decision ; otx:title ?title ; otx:body ?body . BIND("decision" AS ?type) }
    UNION { ?s a otx:Knowledge ; otx:title ?title ; otx:body ?body . BIND("knowledge" AS ?type) }
    UNION { ?s a otx:Issue ; otx:title ?title ; otx:body ?body . BIND("issue" AS ?type) }
  }
  FILTER(CONTAINS(LCASE(?title), "keyword") || CONTAINS(LCASE(?body), "keyword"))
} LIMIT 10
\`\`\`

#### Ingesting External Sources

When the user shares a URL, file path, or external content, follow this protocol:

1. **Duplicate check** — Query for existing sources with the same URL or title.
2. **Register** — Push an \`otx:Source\` with status "pending" using the \`push\` tool.
3. **Read** — Fetch URL content, read file, or use pasted text directly.
4. **Extract** — Summarize key concepts. Create \`otx:Knowledge\` triples linked via \`otx:relatedTo\`.
5. **Cross-reference** — Query existing graph for related decisions/issues/knowledge. Link via \`otx:relatedTo\`.
6. **Contradictions** — If new knowledge contradicts existing entries, create \`otx:Issue\` with status "open".
7. **Finalize** — Update source status from "pending" to "ingested". Run audit query.

Duplicate check: \`SELECT ?s ?title WHERE { GRAPH <${contextUri}> { ?s a otx:Source ; otx:sourceUrl ?url . FILTER(?url = "URL") } }\`
Audit: \`SELECT ?s ?title ?status (COUNT(?k) AS ?knowledgeCount) WHERE { GRAPH <${contextUri}> { ?s a otx:Source ; otx:title ?title ; otx:status ?status . OPTIONAL { ?k otx:relatedTo ?s } } } GROUP BY ?s ?title ?status\`
Registration: \`<urn:source:{slug}> a otx:Source ; otx:title "..." ; otx:sourceUrl "..." ; otx:sourceType "article" ; otx:date "YYYY-MM-DD"^^xsd:date ; otx:status "pending" .\`
Types: article | paper | code | transcript | documentation | video | podcast | book | other. Status: pending → ingested → stale. Recovery: \`rollback\`.

#### After Working

- Run \`context_scan\` after significant code changes (\`depth="module"\` for fast, \`depth="symbol"\` for thorough).

#### Tool Reference

| Tool | When to Use |
|------|-------------|
| \`context_load\` | Session start — loads recent sessions, open issues, recent decisions |
| \`context_scan\` | After code changes — rescans module/symbol dependencies |
| \`context_impact\` | Before editing — checks blast radius of a file change |
| \`schema\` | Explore ontology classes and properties |
| \`query\` | Run any SPARQL query against the project graph |
| \`push\` | Record decisions, issues, knowledge, sources, or session summaries |
| \`doctor\` | Diagnose project health (config, store, hooks, CLAUDE.md) |

### Session End

Push a summary at the end of each meaningful session:

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:session:YYYY-MM-DD> a otx:Session ;
    otx:title "Session summary here" ;
    otx:date "YYYY-MM-DD"^^xsd:date ;
    otx:body "What was done" ;
    otx:nextTodo "What to do next" .
\`\`\`
${MARKER_END}`;
}

export function updateClaudeMd(filePath: string, section: string): void {
  if (!existsSync(filePath)) {
    // Case 1: No file — create with just the section
    writeFileSync(filePath, section + '\n', 'utf-8');
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const beginIdx = content.indexOf(MARKER_BEGIN);
  const endIdx = content.indexOf(MARKER_END);

  if (beginIdx === -1 || endIdx === -1) {
    // Case 2: File exists but no markers — append
    writeFileSync(filePath, content.trimEnd() + '\n\n' + section + '\n', 'utf-8');
    return;
  }

  // Case 3: File exists with markers — replace between markers
  const before = content.substring(0, beginIdx);
  const after = content.substring(endIdx + MARKER_END.length);
  writeFileSync(filePath, before + section + after, 'utf-8');
}
