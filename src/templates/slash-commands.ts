export interface SlashCommand {
  filename: string;
  content: string;
}

export function generateSlashCommands(): SlashCommand[] {
  return [
    {
      filename: 'context-init.md',
      content: `Use the opentology_context_init MCP tool to initialize the project context graph.

After initialization:
1. Report what was created (graphs, hook script, CLAUDE.md, slash commands).
2. Show the hook JSON snippet the user needs to add to .claude/settings.json.

## Codebase Analysis

After context_init completes, call opentology_context_scan to get a codebase snapshot.

Analyze the \`codebaseSnapshot\` field from the response and create Knowledge triples to push via \`opentology_push\`.

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
      content: `Use the opentology_context_load MCP tool to load the current project context.

Display the results in a readable format:
- Recent sessions with dates and next todos
- Open issues
- Recent decisions

If context is not initialized, suggest running /context-init first.
`,
    },
    {
      filename: 'context-save.md',
      content: `Save a session summary to the OpenTology sessions graph.

Ask the user what was accomplished in this session, or summarize the conversation so far.

Then use opentology_push to insert a session record:

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:session:{today's date}> a otx:Session ;
    otx:title "{session summary title}" ;
    otx:date "{YYYY-MM-DD}"^^xsd:date ;
    otx:body "{what was done}" ;
    otx:nextTodo "{what to do next}" .
\`\`\`

Push to the sessions graph (use graph name "sessions").
`,
    },
    {
      filename: 'context-scan.md',
      content: `Use the opentology_context_scan MCP tool to scan the current project codebase.

The tool returns a structured \`codebaseSnapshot\` containing package.json, directory tree, entry points, detected imports, and README.

Analyze the snapshot and create Knowledge triples to push via \`opentology_push\`:
- **Project triple** (\`otx:Project\`): name, description, tech stack, status "active"
- **Knowledge triples** (\`otx:Knowledge\`): architectural patterns, framework choices, build setup, project structure

Push to the **context** graph (use graph name "context"). Keep each push under 100 triples.
`,
    },
    {
      filename: 'context-status.md',
      content: `Use the opentology_context_status MCP tool to check the project context initialization status.

Display the results clearly: whether context is initialized, graph triple counts, hook presence, and CLAUDE.md status.
`,
    },
  ];
}
