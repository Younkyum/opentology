import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MARKER_BEGIN = '<!-- OPENTOLOGY:CONTEXT:BEGIN -->';
const MARKER_END = '<!-- OPENTOLOGY:CONTEXT:END -->';

export function generateContextSection(projectId: string, graphUri: string): string {
  const contextUri = `${graphUri}/context`;
  const sessionsUri = `${graphUri}/sessions`;

  return `${MARKER_BEGIN}
## Context Management — OpenTology

This project uses OpenTology as its project context graph.

### Graph Structure

| Graph | URI | Purpose |
|-------|-----|---------|
| context | \`${contextUri}\` | Decisions, issues, knowledge |
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
| \`otx:Module\` | Source file module |
| \`otx:Class\` | Class definition (symbol scan) |
| \`otx:Interface\` | Interface definition (symbol scan) |
| \`otx:Function\` | Function definition (symbol scan) |
| \`otx:Method\` | Method definition (symbol scan) |
| \`otx:MethodCall\` | Call relationship between symbols (symbol scan) |

| Property | Range | Description |
|----------|-------|-------------|
| \`otx:title\` | string | Title |
| \`otx:date\` | date | Date (YYYY-MM-DD) |
| \`otx:body\` | string | Body content |
| \`otx:status\` | string | Status (open/resolved/active) |
| \`otx:reason\` | string | Decision rationale |
| \`otx:nextTodo\` | string | Next action item |
| \`otx:relatedTo\` | resource | Related entity |
| \`otx:dependsOn\` | Module | Module import dependency |
| \`otx:definedIn\` | Module | Which module a symbol belongs to |
| \`otx:callerSymbol\` | string | Caller in a MethodCall |
| \`otx:calleeSymbol\` | string | Callee in a MethodCall |
| \`otx:calls\` | resource | Call relationship |

### When to Record

| Trigger | Type | Graph |
|---------|------|-------|
| Architecture/tech decision | \`otx:Decision\` | context |
| Bug/issue resolved | \`otx:Issue\` | context |
| Reusable knowledge | \`otx:Knowledge\` | context |
| Session end | \`otx:Session\` | sessions |

### Query Examples

\`\`\`sparql
# Recent sessions
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?title ?date ?nextTodo WHERE {
  GRAPH <${sessionsUri}> {
    ?s a otx:Session ; otx:title ?title ; otx:date ?date .
    OPTIONAL { ?s otx:nextTodo ?nextTodo }
  }
} ORDER BY DESC(?date) LIMIT 5

# Open issues
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?title ?date WHERE {
  GRAPH <${contextUri}> {
    ?s a otx:Issue ; otx:title ?title ; otx:date ?date ; otx:status "open" .
  }
} ORDER BY DESC(?date)
\`\`\`

### How to Use OpenTology Tools

OpenTology provides MCP tools to query and manage the project knowledge graph. Use them proactively.

#### Pre-Analysis Context Check

Before exploring code or analyzing architecture, query the knowledge graph for existing context:
- **Decisions**: past architectural choices that may inform the current analysis
- **Knowledge**: reusable patterns or lessons already recorded
- **Issues**: known problems related to the area under investigation
- **Sessions**: recent work in the same area

\`\`\`sparql
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?type ?title ?body WHERE {
  GRAPH <${contextUri}> {
    { ?s a otx:Decision ; otx:title ?title ; otx:body ?body . BIND("decision" AS ?type) }
    UNION
    { ?s a otx:Knowledge ; otx:title ?title ; otx:body ?body . BIND("knowledge" AS ?type) }
    UNION
    { ?s a otx:Issue ; otx:title ?title ; otx:body ?body . BIND("issue" AS ?type) }
  }
  FILTER(CONTAINS(LCASE(?title), "keyword") || CONTAINS(LCASE(?body), "keyword"))
} LIMIT 10
\`\`\`

This prevents redundant analysis and ensures past decisions and knowledge inform current work.

#### Pre-Edit Impact Check

Before modifying a file, run \`context_impact\` with the target file path to understand the blast radius:
- **dependents** — modules that import or depend on this file
- **dependencies** — modules this file imports
- **related** — decisions, issues, knowledge linked to this file
- **impact level** — high / medium / low

If impact is **high**, inform the user of affected modules and get confirmation before proceeding.

#### Searching the Knowledge Graph

Use \`query\` with SPARQL to find anything in the project graph. **Always query the graph before reading source files** when investigating code structure, dependencies, or call relationships:

- **Decisions**: \`?s a otx:Decision\` — why architectural choices were made
- **Issues**: \`?s a otx:Issue ; otx:status "open"\` — known bugs and their status
- **Knowledge**: \`?s a otx:Knowledge\` — reusable patterns and lessons learned
- **Sessions**: query the sessions graph for past work logs and next TODOs
- **Modules**: \`?s a otx:Module\` — all scanned source modules and their dependencies (\`otx:dependsOn\`)
- **Symbols**: \`?s a otx:Class\`, \`otx:Interface\`, \`otx:Function\`, \`otx:Method\` — code-level entities (available after symbol-depth scan)
- **Call graph**: \`?s a otx:MethodCall\` — who calls whom (available after symbol scan with \`includeMethodCalls=true\`)

\`\`\`sparql
# Functions in a specific module
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?name WHERE {
  GRAPH <${contextUri}> {
    ?f a otx:Function ; otx:title ?name ; otx:definedIn <urn:module:src/mcp/server> .
  }
}

# Who calls a specific function?
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?caller WHERE {
  GRAPH <${contextUri}> {
    ?s a otx:MethodCall ; otx:callerSymbol ?caller ; otx:calleeSymbol ?callee .
    FILTER(CONTAINS(?callee, "persistGraph"))
  }
}

# Module dependency chain (what depends on a module?)
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?dependent WHERE {
  GRAPH <${contextUri}> {
    ?dependent otx:dependsOn+ <urn:module:src/lib/store-adapter> .
  }
}
\`\`\`

#### Post-Edit Graph Update

After significant code changes (new files, renamed functions, changed dependencies), run \`context_scan\` to keep the knowledge graph in sync:
- \`depth="module"\` — fast, updates file-level imports
- \`depth="symbol"\` with \`includeMethodCalls=true\` — thorough, updates class/function/call graph

#### Other Useful Tools

| Tool | When to Use |
|------|-------------|
| \`context_load\` | Session start — loads recent sessions, open issues, recent decisions |
| \`context_scan\` | After significant code changes — rescans module/symbol dependencies |
| \`context_impact\` | Before editing — checks blast radius of a file change |
| \`schema\` | Explore ontology classes and properties, or inspect a specific class |
| \`query\` | Run any SPARQL query against the project graph |
| \`push\` | Record decisions, issues, knowledge, or session summaries |
| \`doctor\` | Diagnose project health (config, store, hooks, CLAUDE.md) |

### Session End Reminder

At the end of each session, push a summary:

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
