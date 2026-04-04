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

| Property | Range | Description |
|----------|-------|-------------|
| \`otx:title\` | string | Title |
| \`otx:date\` | date | Date (YYYY-MM-DD) |
| \`otx:body\` | string | Body content |
| \`otx:status\` | string | Status (open/resolved/active) |
| \`otx:reason\` | string | Decision rationale |
| \`otx:nextTodo\` | string | Next action item |
| \`otx:relatedTo\` | resource | Related entity |

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
