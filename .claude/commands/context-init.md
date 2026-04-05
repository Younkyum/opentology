Use the context_init MCP tool to initialize the project context graph.

After initialization:
1. Report what was created (graphs, hook script, CLAUDE.md, slash commands).
2. Show the hook JSON snippet the user needs to add to .claude/settings.json.

## Codebase Analysis

After context_init completes, call context_scan to get a codebase snapshot.

Analyze the `codebaseSnapshot` field from the response and create Knowledge triples to push via `push`.

### What to extract:
- **Project triple** (`otx:Project`): name, description, tech stack (`otx:stack`), status "active"
- **Knowledge triples** (`otx:Knowledge`): key architectural patterns, framework choices, build setup, project structure summary

### Push instructions:
- Push to the **context** graph (use graph name "context")
- Use Turtle format with `otx:` and `xsd:` prefixes
- Keep each push under 100 triples
- Use URIs like `urn:project:{name}`, `urn:knowledge:{slug}`

### Example triples:

```turtle
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
```

### On subsequent runs (graph already populated):
- Query existing Knowledge triples first
- Update or add new triples for any changes detected
- Do not duplicate existing knowledge
