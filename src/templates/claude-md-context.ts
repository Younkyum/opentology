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
| \`otx:Activity\` | Individual task within a session |
| \`otx:Todo\` | Trackable action item (open → in-progress → done \\| dropped) |
| \`otx:Insight\` | Inductively derived knowledge from session patterns |
| \`otx:Domain\` | Work area tag for sessions and activities |
| \`otx:Pattern\` | Recurring patterns/conventions |
| \`otx:Source\` | External knowledge source (article, paper, code, etc.) |
| \`otx:Module\` | Source file module |
| \`otx:Class\` / \`otx:Interface\` / \`otx:Function\` / \`otx:Method\` | Symbol-level entities (from deep scan) |
| \`otx:MethodCall\` | Call relationship between symbols |

Key properties: \`otx:title\`, \`otx:date\`, \`otx:body\`, \`otx:status\`, \`otx:reason\`, \`otx:relatedTo\`, \`otx:dependsOn\`, \`otx:definedIn\`, \`otx:callerSymbol\`, \`otx:calleeSymbol\`, \`otx:sourceUrl\`, \`otx:sourceType\`. Session properties: \`otx:hasActivity\`, \`otx:followsUp\`, \`otx:domain\`, \`otx:impact\`, \`otx:activityType\`, \`otx:summary\`, \`otx:touchedModule\`, \`otx:createdIn\`, \`otx:resolvedIn\`, \`otx:priority\`, \`otx:confidence\`, \`otx:evidence\`, \`otx:supersedes\`. Full schema: use the \`schema\` tool.

### When to Record

| Trigger | Type | Graph |
|---------|------|-------|
| Architecture/tech decision | \`otx:Decision\` | context |
| Bug/issue resolved | \`otx:Issue\` | context |
| Reusable knowledge | \`otx:Knowledge\` | context |
| Source ingested | \`otx:Source\` | context |
| Session end | \`otx:Session\` + \`otx:Activity\` + \`otx:Todo\` | sessions |
| Pattern/lesson from sessions | \`otx:Insight\` | sessions |

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

### Session Start — Sub-brain Query

At the start of each session, query for open Todos and recent Insights to restore working context:

\`\`\`sparql
PREFIX otx: <https://opentology.dev/vocab#>
SELECT ?type ?title ?status ?priority WHERE {
  GRAPH <${sessionsUri}> {
    { ?s a otx:Todo ; otx:title ?title ; otx:status ?status .
      OPTIONAL { ?s otx:priority ?priority }
      FILTER(?status = "open" || ?status = "in-progress")
      BIND("todo" AS ?type) }
    UNION
    { ?s a otx:Insight ; otx:title ?title ; otx:confidence ?status .
      BIND("insight" AS ?type) BIND("" AS ?priority) }
  }
} ORDER BY DESC(?priority) LIMIT 20
\`\`\`

### Session End — Structured Recording

Push a structured session at the end of each meaningful session. Use \`/context-save\` for the full workflow. Minimal example:

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# Session with domain and chaining
<urn:session:YYYY-MM-DD> a otx:Session ;
    otx:title "Session summary" ;
    otx:date "YYYY-MM-DD"^^xsd:date ;
    otx:body "What was done" ;
    otx:domain <urn:domain:{slug}> ;
    otx:impact "medium" ;
    otx:followsUp <urn:session:PREV-DATE> ;
    otx:hasActivity <urn:activity:YYYY-MM-DD-1> .

# Activity per task
<urn:activity:YYYY-MM-DD-1> a otx:Activity ;
    otx:activityType "feature" ;
    otx:summary "What this task did" ;
    otx:touchedModule <urn:module:src/path/file.ts> .

# Open todo
<urn:todo:YYYY-MM-DD-slug> a otx:Todo ;
    otx:title "Next action" ;
    otx:status "open" ;
    otx:priority "high" ;
    otx:createdIn <urn:session:YYYY-MM-DD> .
\`\`\`
${MARKER_END}`;
}

const GLOBAL_MARKER_BEGIN = '<!-- OPENTOLOGY:GLOBAL:BEGIN -->';
const GLOBAL_MARKER_END = '<!-- OPENTOLOGY:GLOBAL:END -->';

export function generateGlobalSection(): string {
  return `${GLOBAL_MARKER_BEGIN}
# OpenTology — RDF 기반 프로젝트 컨텍스트 관리

Claude Code는 글로벌 MCP \`opentology\`를 통해 프로젝트 지식을 RDF 그래프로 관리한다.
온톨로지, 도구 사용법, SPARQL 예시 등 상세 정보는 프로젝트별 CLAUDE.md에 자동 생성된다.
여기서는 **모든 프로젝트에 공통 적용되는 행동 규칙만** 정의한다.

## 핵심 원칙

1. **그래프 먼저** — 코드를 읽거나 가정하기 전에 \`query\`로 그래프를 먼저 조회한다.
2. **항상 기록** — 세션 종료 시 \`otx:Session\`, 의미 있는 작업은 \`Knowledge\`/\`Decision\`/\`Issue\`로 기록.
3. **자동 수집** — 사용자가 URL이나 외부 소스를 공유하면 ingest 프로토콜을 자동 실행한다.
4. **영향도 확인** — 파일 수정 전 \`context_impact\`로 blast radius를 확인한다.

## URI 규칙

| 대상 | 패턴 | 예시 |
|------|------|------|
| 프로젝트 | \`urn:project:{name}\` | \`urn:project:opentology\` |
| 세션 | \`urn:session:{date}\` | \`urn:session:2026-04-05\` |
| 의사결정 | \`urn:decision:{date}-{slug}\` | \`urn:decision:2026-04-05-ingest-feature\` |
| 이슈 | \`urn:issue:{id}\` | \`urn:issue:1\` |
| 지식 | \`urn:knowledge:{slug}\` | \`urn:knowledge:wasm-oxigraph\` |
| 패턴 | \`urn:pattern:{slug}\` | \`urn:pattern:singleton-adapter\` |
| 소스 | \`urn:source:{slug}\` | \`urn:source:karpathy-llm-wiki\` |
| 활동 | \`urn:activity:{date}-{n}\` | \`urn:activity:2026-04-05-1\` |
| 할일 | \`urn:todo:{date}-{slug}\` | \`urn:todo:2026-04-05-error-handling\` |
| 인사이트 | \`urn:insight:{slug}\` | \`urn:insight:push-error-pattern\` |
| 도메인 | \`urn:domain:{slug}\` | \`urn:domain:mcp-tools\` |

## 기록 기준

- **기록함**: 아키텍처 변경, 새 기능 구현, 버그 해결, 재사용 가능한 지식, 외부 소스 수집
- **기록 안 함**: 오타 수정, 단순 질문 응답, 단순 설정 변경
- 기록은 **간결하게**. 민감 정보(API 키 등)는 절대 기록하지 않는다.
- \`opentology\` MCP가 연결되지 않은 프로젝트에서는 기록을 건너뛴다.
${GLOBAL_MARKER_END}`;
}

export function updateGlobalClaudeMd(filePath: string): void {
  const section = generateGlobalSection();

  if (!existsSync(filePath)) {
    writeFileSync(filePath, section + '\n', 'utf-8');
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const beginIdx = content.indexOf(GLOBAL_MARKER_BEGIN);
  const endIdx = content.indexOf(GLOBAL_MARKER_END);

  if (beginIdx === -1 || endIdx === -1) {
    // No markers — prepend before existing content
    writeFileSync(filePath, section + '\n\n' + content, 'utf-8');
    return;
  }

  // Replace between markers
  const before = content.substring(0, beginIdx);
  const after = content.substring(endIdx + GLOBAL_MARKER_END.length);
  writeFileSync(filePath, before + section + after, 'utf-8');
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
