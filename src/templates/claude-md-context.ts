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
- **Impact check** — before editing a file, run \`context_impact\` to understand the blast radius.
</principles>

### Graph Structure

| Graph | URI | Purpose |
|-------|-----|---------|
| context | \`${contextUri}\` | Decisions, issues, knowledge, modules, symbols |
| sessions | \`${sessionsUri}\` | Session work logs (Activity, Todo, Insight, Domain) |

### Ontology (\`otx:\` prefix)

**Context graph**: \`Project\`, \`Decision\`, \`Issue\`, \`Knowledge\`, \`Pattern\`, \`Source\`, \`Module\`, \`Class\`, \`Interface\`, \`Function\`, \`Method\`, \`MethodCall\`.
**Sessions graph**: \`Session\`, \`Activity\`, \`Todo\` (open→in-progress→done|dropped), \`Insight\`, \`Domain\`.
Full schema and properties: use the \`schema\` tool.

### When to Record

| Trigger | Type | Graph |
|---------|------|-------|
| Architecture/tech decision | \`otx:Decision\` | context |
| Bug/issue resolved | \`otx:Issue\` | context |
| Reusable knowledge | \`otx:Knowledge\` | context |
| Source ingested | \`otx:Source\` | context |
| Session end | \`otx:Session\` + \`Activity\` + \`Todo\` | sessions |
| Pattern/lesson from sessions | \`otx:Insight\` | sessions |

### Tools

| Tool | When to Use |
|------|-------------|
| \`context_load\` | Session start — loads context + open Todos + Insights |
| \`context_scan\` | After code changes — rescans dependencies (\`depth="module"\\|"symbol"\`) |
| \`context_impact\` | Before editing — blast radius check |
| \`context_search\` | Search graph by keyword (wraps SPARQL) |
| \`schema\` | Explore ontology classes and properties |
| \`query\` | Run any SPARQL query against the graph |
| \`push\` | Record decisions, issues, knowledge, sources, sessions |
| \`delete\` | Remove specific triples or pattern-based deletion |
| \`doctor\` | Diagnose project health |

### Workflows

**Before working**: \`query\` graph for related decisions/knowledge/issues → \`context_impact\` on files to edit.

**Search**: \`SELECT ?s ?title ?body WHERE { GRAPH <${contextUri}> { ?s a otx:Decision ; otx:title ?title ; otx:body ?body } FILTER(CONTAINS(LCASE(?title), "keyword")) } LIMIT 10\`

**Ingest external sources**: (1) duplicate check by sourceUrl → (2) \`push\` \`otx:Source\` status "pending" → (3) read content → (4) extract \`otx:Knowledge\` linked via \`otx:relatedTo\` → (5) cross-reference existing graph → (6) flag contradictions as \`otx:Issue\` → (7) update status to "ingested".
Source types: article | paper | code | transcript | documentation | video | podcast | book | other.

**After working**: \`context_scan\` after significant code changes.

**Session save**: After completing a meaningful work unit (feature, bugfix, PR, architecture decision), suggest \`/context-save\`. Skip for trivial Q&A, typo fixes, or config tweaks.

### Session End — Structured Recording

Use \`/context-save\` for the full workflow. Minimal example:

\`\`\`turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:session:YYYY-MM-DD> a otx:Session ;
    otx:title "Summary" ; otx:date "YYYY-MM-DD"^^xsd:date ;
    otx:body "What was done" ; otx:domain <urn:domain:{slug}> ;
    otx:impact "medium" ; otx:followsUp <urn:session:PREV> ;
    otx:hasActivity <urn:activity:YYYY-MM-DD-1> .

<urn:activity:YYYY-MM-DD-1> a otx:Activity ;
    otx:activityType "feature" ; otx:summary "Task description" ;
    otx:touchedModule <urn:module:src/path/file.ts> .

<urn:todo:YYYY-MM-DD-slug> a otx:Todo ;
    otx:title "Next action" ; otx:status "open" ;
    otx:priority "high" ; otx:createdIn <urn:session:YYYY-MM-DD> .
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
