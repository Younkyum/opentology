export interface SlashCommand {
  filename: string;
  content: string;
}

export function generateSlashCommands(): SlashCommand[] {
  return [
    {
      filename: 'context-init.md',
      content: `Use the context_init MCP tool to initialize the project context graph.

After initialization:
1. Report what was created (graphs, hook script, CLAUDE.md, slash commands).
2. Show the hook JSON snippet the user needs to add to .claude/settings.json.

## Codebase Analysis

After context_init completes, call context_scan to get a codebase snapshot.

Analyze the \`codebaseSnapshot\` field from the response and create Knowledge triples to push via \`push\`.

### What to extract:
- **Project triple** (\`otx:Project\`): name, description, tech stack (\`otx:stack\`), status "active"
- **Knowledge triples** (\`otx:Knowledge\`): key architectural patterns, framework choices, build setup, project structure summary

### Push instructions:
- Push to the **context** graph (use graph name "context")
- Use Turtle format with \`otx:\` and \`xsd:\` prefixes
- Keep each push under 100 triples
- Use URIs like \`urn:project:{name}\`, \`urn:knowledge:{slug}\`

### Example triples:

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:project:{name}> a otx:Project ;
    otx:title "{name}" ;
    otx:date "{today}"^^xsd:date ;
    otx:body "{description}" ;
    otx:stack "{detected frameworks/languages}" ;
    otx:status "active" .

<urn:knowledge:project-structure> a otx:Knowledge ;
    otx:title "Project Structure" ;
    otx:date "{today}"^^xsd:date ;
    otx:body "Entry points: ... Key directories: ... Build system: ..." ;
    otx:relatedTo <urn:project:{name}> .
\`\`\`

### On subsequent runs (graph already populated):
- Query existing Knowledge triples first
- Update or add new triples for any changes detected
- Do not duplicate existing knowledge
`,
    },
    {
      filename: 'context-load.md',
      content: `Use the context_load MCP tool to load the current project context.

After loading, run these additional queries to surface structured session data:

\`\`\`sparql
# Open Todos (from structured session schema)
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?s ?title ?status ?priority ?created WHERE {
  GRAPH <https://opentology.dev/opentology-context/sessions> {
    ?s a otx:Todo ; otx:title ?title ; otx:status ?status .
    FILTER(?status = "open" || ?status = "in-progress")
    OPTIONAL { ?s otx:priority ?priority }
    OPTIONAL { ?s otx:createdIn ?created }
  }
} ORDER BY DESC(?priority)
\`\`\`

\`\`\`sparql
# Recent Insights
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?s ?title ?confidence ?domain WHERE {
  GRAPH <https://opentology.dev/opentology-context/sessions> {
    ?s a otx:Insight ; otx:title ?title .
    OPTIONAL { ?s otx:confidence ?confidence }
    OPTIONAL { ?s otx:domain ?domain }
  }
} LIMIT 5
\`\`\`

\`\`\`sparql
# Domain activity summary (last 5 sessions)
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?domainTitle (COUNT(?a) AS ?activityCount) WHERE {
  GRAPH <https://opentology.dev/opentology-context/sessions> {
    ?session a otx:Session ; otx:hasActivity ?a .
    OPTIONAL { ?session otx:domain ?d . ?d otx:title ?domainTitle }
  }
} GROUP BY ?domainTitle ORDER BY DESC(?activityCount) LIMIT 5
\`\`\`

Display the results in a readable format:
- **Open Todos** — priority-sorted, with source session
- **Recent Insights** — with confidence level
- **Domain Activity** — which areas have been most active
- **Recent Sessions** — with dates and next todos
- **Open Issues** and **Recent Decisions** (from context_load)

If the previous session has a \`nextTodo\`, highlight it as "Suggested next action".

If context is not initialized, suggest running /context-init first.
`,
    },
    {
      filename: 'context-save.md',
      content: `Save a structured session summary to the OpenTology sessions graph.

## Step 1 — Query previous state

Before recording, run these queries against the sessions graph:

\`\`\`sparql
# Find the most recent session (for followsUp linking)
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?s ?title ?date WHERE {
  GRAPH <https://opentology.dev/opentology-context/sessions> {
    ?s a otx:Session ; otx:title ?title ; otx:date ?date .
  }
} ORDER BY DESC(?date) LIMIT 1
\`\`\`

\`\`\`sparql
# Find open Todos (to update status if resolved)
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?s ?title ?status WHERE {
  GRAPH <https://opentology.dev/opentology-context/sessions> {
    ?s a otx:Todo ; otx:title ?title ; otx:status ?status .
    FILTER(?status = "open" || ?status = "in-progress")
  }
}
\`\`\`

## Step 2 — Decompose the session

Summarize the conversation and break it down into:

1. **Session** — overall summary with domain tag and impact level
2. **Activities** — each distinct task/action as a separate entity
3. **Todos** — new open items + status updates for existing ones
4. **Insight** (optional) — any pattern or lesson learned inductively

## Step 3 — Push structured triples

Push to the sessions graph (use graph name "sessions").

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# Session
<urn:session:{YYYY-MM-DD}> a otx:Session ;
    otx:title "{summary title}" ;
    otx:date "{YYYY-MM-DD}"^^xsd:date ;
    otx:body "{what was done — keep concise}" ;
    otx:domain <urn:domain:{slug}> ;
    otx:impact "{high|medium|low}" ;
    otx:followsUp <{previous session URI, if any}> ;
    otx:hasActivity <urn:activity:{YYYY-MM-DD}-1> .

# Activity (one per distinct task)
<urn:activity:{YYYY-MM-DD}-1> a otx:Activity ;
    otx:activityType "{code-change|bugfix|feature|refactor|research|schema-change|review|deploy}" ;
    otx:summary "{what this activity did}" ;
    otx:touchedModule <urn:module:{file/path}> .

# Todo — new open item
<urn:todo:{YYYY-MM-DD}-{slug}> a otx:Todo ;
    otx:title "{what needs to be done}" ;
    otx:status "open" ;
    otx:priority "{high|medium|low}" ;
    otx:createdIn <urn:session:{YYYY-MM-DD}> .

# Todo — resolve existing (if applicable, use delete+push to update status)
# <urn:todo:{existing}> otx:status "done" ; otx:resolvedIn <urn:session:{YYYY-MM-DD}> .

# Insight (optional — only if a pattern emerged)
# <urn:insight:{slug}> a otx:Insight ;
#     otx:title "{pattern or lesson}" ;
#     otx:confidence "{high|medium|low}" ;
#     otx:evidence <urn:session:{YYYY-MM-DD}> ;
#     otx:domain <urn:domain:{slug}> .

# Domain (create only if new)
# <urn:domain:{slug}> a otx:Domain ; otx:title "{Domain Name}" .
\`\`\`

## Guidelines

- **Multiple sessions per day**: append a counter, e.g. \`urn:session:2026-04-06-2\`
- **Activity types**: code-change, bugfix, feature, refactor, research, schema-change, review, deploy (free-form OK)
- **Todo status machine**: open → in-progress → done | dropped (dropped requires otx:reason)
- **Insight confidence**: high (3+ evidence), medium (2 evidence), low (1 evidence / hunch)
- **Domain**: reuse existing domains when possible. Query first before creating new ones.
- **followsUp**: always link to the previous session if one exists
`,
    },
    {
      filename: 'context-todos.md',
      content: `Manage open Todos in the OpenTology sessions graph.

## Step 1 — List open Todos

\`\`\`sparql
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?s ?title ?status ?priority ?createdIn WHERE {
  GRAPH <https://opentology.dev/opentology-context/sessions> {
    ?s a otx:Todo ; otx:title ?title ; otx:status ?status .
    FILTER(?status = "open" || ?status = "in-progress")
    OPTIONAL { ?s otx:priority ?priority }
    OPTIONAL { ?s otx:createdIn ?createdIn }
  }
} ORDER BY DESC(?priority)
\`\`\`

Display as a numbered list with priority and status.

## Step 2 — Ask for action

Ask the user what they want to do:
- **Start** a todo (open → in-progress)
- **Complete** a todo (→ done, link resolvedIn to current session)
- **Drop** a todo (→ dropped, ask for reason)
- **Nothing** — just viewing

## Step 3 — Update status

Use the \`delete\` tool to remove the old status triple, then \`push\` the updated triples:

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .

# For "done":
<{todo-uri}> otx:status "done" ;
    otx:resolvedIn <urn:session:{today}> .

# For "dropped":
<{todo-uri}> otx:status "dropped" ;
    otx:reason "{reason}" ;
    otx:resolvedIn <urn:session:{today}> .

# For "in-progress":
<{todo-uri}> otx:status "in-progress" .
\`\`\`

### Delete old status
Use SPARQL DELETE to remove the previous status triple before pushing the new one:
\`\`\`sparql
DELETE DATA { GRAPH <https://opentology.dev/opentology-context/sessions> {
  <{todo-uri}> <https://opentology.dev/vocab#status> "{old-status}" .
} }
\`\`\`
`,
    },
    {
      filename: 'context-scan.md',
      content: `Before scanning, ask the user which scan depth they want:

1. **Module scan** (default) — fast, file-level analysis. Returns directory tree, entry points, detected imports, and dependency graph. Good for a quick project overview.
2. **Deep scan** (symbol) — slower, extracts classes, interfaces, functions, and method calls using ts-morph (TypeScript) or Tree-sitter (Go, Python, Rust, Java, Swift). Auto-pushes symbol triples to the context graph. Use when you need detailed architectural understanding.

Once the user chooses (or accepts the default), call the context_scan MCP tool with the appropriate \`depth\` parameter ("module" or "symbol").

After the scan completes, analyze the results and create Knowledge triples to push via \`push\`:
- **Project triple** (\`otx:Project\`): name, description, tech stack, status "active"
- **Knowledge triples** (\`otx:Knowledge\`): architectural patterns, framework choices, build setup, project structure

Push to the **context** graph (use graph name "context"). Keep each push under 100 triples.
`,
    },
    {
      filename: 'context-status.md',
      content: `Use the context_status MCP tool to check the project context initialization status.

Display the results clearly: whether context is initialized, graph triple counts, hook presence, and CLAUDE.md status.
`,
    },
    {
      filename: 'context-graph.md',
      content: `Use the context_graph MCP tool to start an interactive graph visualization web server.

The tool starts a local web server and returns a URL. Tell the user:
1. The URL to open in their browser (e.g. http://localhost:PORT)
2. They can explore classes, instances, and relationships visually
3. The sidebar has a SPARQL query box for custom queries
4. Click any node to see its properties
5. Use the graph selector dropdown to switch between named graphs
6. Press Ctrl+C in the terminal to stop the server

If context is not initialized, suggest running /context-init first.
`,
    },
  ];
}
