export interface SlashCommand {
  filename: string;
  content: string;
}

export function generateSlashCommands(): SlashCommand[] {
  return [
    {
      filename: 'opentology-context-init.md',
      content: `Use the opentology_context_init MCP tool to initialize the project context graph.

After initialization, report what was created (graphs, hook script, CLAUDE.md).
Then show the hook JSON snippet the user needs to add to .claude/settings.json.
`,
    },
    {
      filename: 'opentology-context-load.md',
      content: `Use the opentology_context_load MCP tool to load the current project context.

Display the results in a readable format:
- Recent sessions with dates and next todos
- Open issues
- Recent decisions

If context is not initialized, suggest running /opentology-context-init first.
`,
    },
    {
      filename: 'opentology-context-save.md',
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
      filename: 'opentology-context-status.md',
      content: `Use the opentology_context_status MCP tool to check the project context initialization status.

Display the results clearly: whether context is initialized, graph triple counts, hook presence, and CLAUDE.md status.
`,
    },
  ];
}
