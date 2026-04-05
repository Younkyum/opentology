# OpenTology

> Ontology-powered project memory for AI coding assistants — your codebase as a knowledge graph

[![npm](https://img.shields.io/npm/v/opentology)](https://www.npmjs.com/package/opentology) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Live Demo](https://img.shields.io/badge/Live_Demo-opentology.dev-6c63ff)](https://opentology.dev)

[English](#english) | [한국어](#한국어)

---

## English

Most MCP servers give AI assistants tools. OpenTology gives them **understanding**.

When you connect OpenTology to Claude Code (or any MCP client), it doesn't just expose SPARQL queries — it builds a persistent knowledge graph of your project: module dependencies, architectural decisions, resolved bugs, session history, and code-level symbols. Then it **automatically instructs** the AI to check impact before editing, search past decisions before choosing, and record what it learns.

The result: an AI assistant that remembers across sessions, understands your codebase structure, and thinks before it acts.

**[See the live knowledge graph at opentology.dev](https://opentology.dev)** — OpenTology scanning its own codebase: 67 modules, 234 call relations, fully interactive.

### How It Works

```
npm install -g opentology          # 1. Install
opentology context init            # 2. Initialize (creates graph + hooks + CLAUDE.md instructions)
opentology context scan            # 3. Scan codebase into the knowledge graph
                                   # 4. Done — AI now uses the graph automatically
```

After setup, every session follows this cycle:

```
┌─────────── Session Start ───────────┐
│ SessionStart hook                   │
│   → context_sync (auto-recover      │
│     missed sessions, rescan modules) │
│                                     │
│ "Edit src/lib/reasoner.ts"          │
│   → context_impact (blast radius)   │
│   → "5 dependents, impact: high"    │
│   → Confirms with user, then edits  │
│                                     │
│ Encounters a bug                    │
│   → query (search past issues)      │
│   → Finds similar resolved issue    │
│                                     │
│ Makes architecture decision         │
│   → push (records Decision)         │
│                                     │
│ Session End                         │
│   → push (records Session summary)  │
└─────────────────────────────────────┘
```

### What Makes This Different

| | Typical MCP | OpenTology |
|---|---|---|
| Provides | Tools only | Tools + behavioral instructions + auto-sync hooks |
| AI behavior | User must prompt correctly | AI proactively checks impact, searches context |
| Memory | Resets every session | Persistent knowledge graph across sessions |
| Codebase awareness | None | Module dependencies, symbols, call graphs |
| Setup | Manual per-project config | One command (`context init`) |

OpenTology doesn't just add capabilities — it **shapes how the AI works** on your project.

### Why Graph over grep?

We ran a real experiment on this codebase: the same question answered with grep vs the knowledge graph.

**Q: "What breaks if I change `store-adapter.ts`?"**

| | grep / ripgrep | OpenTology |
|---|---|---|
| Calls needed | **6** (direct imports + 2nd-level deps + test files) | **1** (`context_impact`) |
| Files found | 7 (missed dead-code dependents) | 9 (complete, including dead code) |
| Impact severity | Not available | `HIGH` — returned automatically |
| Manual work | Trace each import, search consumers, assemble the list yourself | None — one call returns the full picture |

```bash
# grep: 6 separate searches to assemble the dependency chain
$ rg "import.*store-adapter" src/          # Step 1: direct imports (7 files)
$ rg "import.*store-factory" src/          # Step 2: who imports those?
$ rg "import.*reasoner" src/               # Step 3: ...and those?
$ rg "import.*visualizer" src/             # Step 4
$ rg "import.*embedded-adapter" src/       # Step 5
$ rg "store-adapter|store-factory" tests/  # Step 6: test files

# OpenTology: 1 call
$ opentology context impact src/lib/store-adapter.ts
# → Impact: HIGH | 9 dependents | 0 dependencies
```

**Q: "How does `embedded-adapter` reach `reasoner`?"**

| | grep | OpenTology |
|---|---|---|
| Calls needed | **4** + manual code reading | **1** SPARQL query |
| Result | Manual path assembly: adapter -> store-factory -> reasoner | Transitive closure (`dependsOn+`) returns all paths |
| Bonus | None | Returns all 14 modules that reach reasoner, including indirect paths |

```sparql
# One query finds all transitive paths
SELECT ?from ?to WHERE {
  ?from otx:dependsOn+ ?to .
  FILTER(?to = <urn:module:src/lib/reasoner>)
}
# Returns all 14 modules that reach reasoner, including indirect paths
```

**[See the interactive comparison at opentology.dev](https://opentology.dev)** — switch between Impact Analysis and Call Path Tracing scenarios.

### The Knowledge Graph

Everything lives in RDF named graphs with the `otx:` ontology:

```
context graph                        sessions graph
├── otx:Module (source files)        └── otx:Session (work logs)
│   └── otx:dependsOn                    ├── otx:body (what was done)
├── otx:Class / otx:Interface            └── otx:nextTodo (what's next)
│   └── otx:Method / otx:Function
├── otx:Decision (architecture choices)
├── otx:Issue (bugs, status tracking)
└── otx:Knowledge (reusable patterns)
```

Query anything with SPARQL:

```sparql
# What depends on this module?
SELECT ?dep WHERE { ?dep otx:dependsOn <urn:module:src/lib/reasoner> }

# What decisions were made about auth?
SELECT ?title ?reason WHERE {
  ?d a otx:Decision ; otx:title ?title ; otx:reason ?reason
  FILTER(CONTAINS(LCASE(?title), "auth"))
}

# What did we do last session?
SELECT ?title ?body ?next WHERE {
  ?s a otx:Session ; otx:title ?title ; otx:date ?date ; otx:body ?body
  OPTIONAL { ?s otx:nextTodo ?next }
} ORDER BY DESC(?date) LIMIT 1
```

### Quick Start

#### 1. Add to your MCP client

```json
{
  "mcpServers": {
    "opentology": {
      "command": "npx",
      "args": ["-y", "opentology", "mcp"]
    }
  }
}
```

#### 2. Initialize project context

Ask your AI assistant to run `context_init`, or from the CLI:

```bash
opentology context init
```

This creates:
- `.opentology.json` — project config
- Context and sessions named graphs
- SessionStart hook for auto-sync
- CLAUDE.md instructions (impact checks, graph queries, session recording)

#### 3. Scan your codebase

```bash
opentology context scan
```

Builds the module dependency graph. For deeper analysis:

```json
{ "depth": "symbol", "includeMethodCalls": true }
```

#### 4. Work normally

The AI now automatically:
- Checks `context_impact` before editing files
- Searches decisions/issues/knowledge when relevant
- Records session summaries at the end

### Codebase Scanning

| Depth | What it extracts | Use case |
|-------|-----------------|----------|
| `module` (default) | File-level import graph | Impact analysis, dependency tracking |
| `symbol` | Classes, interfaces, functions, methods, call graphs | Deep code understanding |

**Supported languages for symbol-level scan:**

| Language | Engine |
|----------|--------|
| TypeScript/JavaScript | ts-morph |
| Python | Tree-sitter |
| Go | Tree-sitter |
| Rust | Tree-sitter |
| Java | Tree-sitter |
| Swift | Tree-sitter |

Optional dependencies for symbol scan:

```bash
npm install ts-morph                          # TypeScript/JavaScript
npm install web-tree-sitter tree-sitter-wasms # Python, Go, Rust, Java, Swift
```

### RDF Infrastructure

Under the hood, OpenTology is a full RDF/SPARQL toolkit:

- **RDFS reasoning** — push data, get automatic inference (subClassOf, domain, range)
- **SHACL validation** — shape constraints checked on every push
- **Two storage modes** — embedded (WASM, zero Docker) or HTTP (Oxigraph server)
- **Interactive visualization** — web UI for exploring the graph (`opentology context graph`)
- **Named graph scoping** — queries auto-scope to your project

```bash
# Push RDF data with auto-inference
opentology push ontology.ttl

# Query with auto-prefixed SPARQL
opentology query 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10'

# Visualize schema
opentology viz schema

# Health check
opentology doctor
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `context init` | Initialize project context (graphs + hooks + CLAUDE.md) |
| `context scan` | Scan codebase into knowledge graph |
| `context load` | Load recent sessions, open issues, decisions |
| `context impact` | Analyze blast radius of a file change |
| `context sync` | Auto-recover sessions from git, rescan modules |
| `context graph` | Start interactive visualization web UI |
| `init` | Initialize RDF project |
| `push` | Push triples with SHACL validation + RDFS inference |
| `query` | Execute SPARQL queries |
| `validate` | Validate Turtle syntax and SHACL shapes |
| `pull` | Export graph as Turtle |
| `diff` | Compare local file vs graph |
| `delete` | Delete triples by file or pattern |
| `drop` | Drop entire graph |
| `infer` | Run/clear RDFS materialization |
| `graph` | Manage named graphs |
| `status` | Show triple counts |
| `doctor` | Diagnose project health |
| `mcp` | Start MCP server |

### MCP Tools (23)

| Tool | Description |
|------|-------------|
| `context_init` | Initialize project context graph |
| `context_load` | Load project context (sessions, issues, decisions) |
| `context_scan` | Scan codebase (module or symbol-level) |
| `context_impact` | Analyze file modification impact |
| `context_sync` | Auto-sync from git history |
| `context_status` | Check context initialization status |
| `context_graph` | Start interactive graph visualization |
| `init` | Initialize RDF project |
| `push` | Validate and push triples |
| `query` | Execute SPARQL queries |
| `validate` | Validate Turtle content |
| `pull` | Export graph as Turtle |
| `drop` | Drop project graph |
| `delete` | Delete triples |
| `diff` | Compare local vs graph |
| `schema` | Introspect ontology schema |
| `infer` | Run RDFS inference |
| `graph_list` | List named graphs |
| `graph_create` | Create named graph |
| `graph_drop` | Drop named graph |
| `visualize` | Generate schema diagram (Mermaid/DOT) |
| `status` | Get project status |
| `doctor` | Check project health |

### System Requirements

- **Node.js** >= 20.0.0
- **oxigraph** uses WebAssembly — runs everywhere Node.js runs, no native build tools needed

### Tech Stack

- TypeScript, Oxigraph WASM, N3.js, commander.js
- @modelcontextprotocol/sdk for MCP server
- shacl-engine for SHACL validation
- ts-morph (optional) for TypeScript symbol analysis
- web-tree-sitter + tree-sitter-wasms (optional) for multi-language analysis

### Roadmap

- [x] Full RDF lifecycle CLI (18 commands)
- [x] MCP server (23 tools + 1 resource)
- [x] RDFS reasoning with auto-materialization
- [x] SHACL validation
- [x] Embedded mode (zero Docker)
- [x] Project context graph (decisions, issues, sessions)
- [x] Codebase scanning (module + symbol level, 6 languages)
- [x] Impact analysis with dependency tracking
- [x] Auto-sync from git history
- [x] AI behavioral instructions via CLAUDE.md injection
- [x] Interactive graph visualization web UI
- [ ] OWL reasoning (owl:sameAs, owl:inverseOf)
- [ ] Remote ontology import
- [ ] Ontology snapshot versioning

### Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Open a Pull Request

### License

MIT

---

## 한국어

대부분의 MCP 서버는 AI에게 도구를 줍니다. OpenTology는 AI에게 **이해**를 줍니다.

OpenTology를 Claude Code(또는 MCP 호환 클라이언트)에 연결하면, 단순히 SPARQL 쿼리를 노출하는 것이 아니라 프로젝트의 영속적인 지식 그래프를 구축합니다: 모듈 의존성, 아키텍처 의사결정, 해결된 버그, 세션 이력, 코드 수준의 심볼까지. 그리고 AI가 **자동으로** 편집 전에 영향도를 확인하고, 의사결정 전에 과거 기록을 검색하고, 배운 것을 기록하도록 **지침을 주입**합니다.

결과: 세션을 넘어 기억하고, 코드베이스 구조를 이해하며, 행동 전에 생각하는 AI 어시스턴트.

**[opentology.dev에서 라이브 지식 그래프 확인](https://opentology.dev)** — OpenTology가 자기 자신의 코드베이스를 스캔한 결과: 67개 모듈, 234개 호출 관계, 인터랙티브 탐색 가능.

### 작동 방식

```
npm install -g opentology          # 1. 설치
opentology context init            # 2. 초기화 (그래프 + 훅 + CLAUDE.md 지침 생성)
opentology context scan            # 3. 코드베이스를 지식 그래프로 스캔
                                   # 4. 끝 — AI가 자동으로 그래프를 활용
```

설정 후 매 세션은 이 사이클을 따릅니다:

```
┌─────────── 세션 시작 ───────────────┐
│ SessionStart 훅                     │
│   → context_sync (놓친 세션 복구,    │
│     모듈 그래프 갱신)                │
│                                     │
│ "src/lib/reasoner.ts 수정해줘"      │
│   → context_impact (폭발 반경 확인) │
│   → "5개 의존 모듈, impact: high"   │
│   → 유저 확인 후 수정               │
│                                     │
│ 버그 발생                           │
│   → query (과거 이슈 검색)          │
│   → 유사한 해결 이슈 발견           │
│                                     │
│ 아키텍처 의사결정                    │
│   → push (Decision 기록)            │
│                                     │
│ 세션 종료                           │
│   → push (Session 요약 기록)        │
└─────────────────────────────────────┘
```

### 무엇이 다른가

| | 일반 MCP | OpenTology |
|---|---|---|
| 제공하는 것 | 도구만 | 도구 + 행동 지침 + 자동 동기화 훅 |
| AI 행동 | 유저가 정확히 프롬프트해야 함 | AI가 자발적으로 영향도 확인, 컨텍스트 검색 |
| 메모리 | 매 세션 리셋 | 세션을 넘어 영속하는 지식 그래프 |
| 코드베이스 인식 | 없음 | 모듈 의존성, 심볼, 호출 그래프 |
| 설정 | 프로젝트마다 수동 설정 | 명령어 하나 (`context init`) |

OpenTology는 기능만 추가하는 것이 아니라, **AI가 프로젝트에서 일하는 방식 자체를 바꿉니다**.

### 왜 grep 대신 그래프인가?

이 코드베이스에서 실제 실험을 했습니다: 같은 질문을 grep과 지식 그래프로 각각 답해 봤습니다.

**Q: "`store-adapter.ts`를 바꾸면 뭐가 깨지나?"**

| | grep / ripgrep | OpenTology |
|---|---|---|
| 필요한 호출 수 | **6번** (직접 import + 2차 의존 추적 + 테스트 파일) | **1번** (`context_impact`) |
| 발견한 파일 수 | 7개 (dead code 의존성 누락) | 9개 (dead code 포함 완전한 결과) |
| 영향도 수준 | 제공 안 됨 | `HIGH` — 자동 반환 |
| 수작업 | 각 import를 추적하고, 소비자를 검색하고, 직접 목록 조합 | 없음 — 한 번의 호출로 전체 그림 |

```bash
# grep: 의존성 체인 조합에 6번의 검색
$ rg "import.*store-adapter" src/          # 1단계: 직접 import (7개 파일)
$ rg "import.*store-factory" src/          # 2단계: 그걸 누가 import?
$ rg "import.*reasoner" src/               # 3단계: ...그리고 그걸?
$ rg "import.*visualizer" src/             # 4단계
$ rg "import.*embedded-adapter" src/       # 5단계
$ rg "store-adapter|store-factory" tests/  # 6단계: 테스트 파일

# OpenTology: 1번의 호출
$ opentology context impact src/lib/store-adapter.ts
# → Impact: HIGH | 9개 의존 모듈 | 0개 종속성
```

**Q: "`embedded-adapter`에서 `reasoner`까지 어떻게 연결되나?"**

| | grep | OpenTology |
|---|---|---|
| 필요한 호출 수 | **4번** + 코드 직접 읽기 | **1번** SPARQL 쿼리 |
| 결과 | 수동 경로 조합: adapter → store-factory → reasoner | 전이 폐포(`dependsOn+`)로 모든 경로 반환 |
| 추가 발견 | 없음 | reasoner에 전이적으로 의존하는 14개 모듈 전체 목록 |

```sparql
-- 한 번의 쿼리로 모든 전이 경로 발견
SELECT ?from ?to WHERE {
  ?from otx:dependsOn+ ?to .
  FILTER(?to = <urn:module:src/lib/reasoner>)
}
-- 간접 경로인 embedded-adapter 포함 14개 모듈 반환
```

**[opentology.dev에서 인터랙티브 비교 보기](https://opentology.dev)** — Impact Analysis와 Call Path Tracing 시나리오를 전환해 보세요.

### 지식 그래프 구조

모든 데이터는 `otx:` 온톨로지를 사용하는 RDF named graph에 저장됩니다:

```
context graph                        sessions graph
├── otx:Module (소스 파일)             └── otx:Session (작업 로그)
│   └── otx:dependsOn                    ├── otx:body (수행한 작업)
├── otx:Class / otx:Interface            └── otx:nextTodo (다음 할 일)
│   └── otx:Method / otx:Function
├── otx:Decision (아키텍처 의사결정)
├── otx:Issue (버그, 상태 추적)
└── otx:Knowledge (재사용 가능한 패턴)
```

SPARQL로 무엇이든 쿼리 가능:

```sparql
# 이 모듈에 의존하는 것은?
SELECT ?dep WHERE { ?dep otx:dependsOn <urn:module:src/lib/reasoner> }

# 인증 관련 의사결정은?
SELECT ?title ?reason WHERE {
  ?d a otx:Decision ; otx:title ?title ; otx:reason ?reason
  FILTER(CONTAINS(LCASE(?title), "auth"))
}

# 지난 세션에서 뭘 했지?
SELECT ?title ?body ?next WHERE {
  ?s a otx:Session ; otx:title ?title ; otx:date ?date ; otx:body ?body
  OPTIONAL { ?s otx:nextTodo ?next }
} ORDER BY DESC(?date) LIMIT 1
```

### 빠른 시작

#### 1. MCP 클라이언트에 추가

```json
{
  "mcpServers": {
    "opentology": {
      "command": "npx",
      "args": ["-y", "opentology", "mcp"]
    }
  }
}
```

#### 2. 프로젝트 컨텍스트 초기화

AI 어시스턴트에게 `context_init` 실행을 요청하거나, CLI에서:

```bash
opentology context init
```

생성되는 것:
- `.opentology.json` — 프로젝트 설정
- context / sessions named graph
- SessionStart 훅 (자동 동기화)
- CLAUDE.md 지침 (영향도 확인, 그래프 쿼리, 세션 기록)

#### 3. 코드베이스 스캔

```bash
opentology context scan
```

모듈 의존성 그래프를 구축합니다. 심볼 수준 분석:

```json
{ "depth": "symbol", "includeMethodCalls": true }
```

#### 4. 평소처럼 작업

AI가 자동으로:
- 파일 수정 전 `context_impact`로 영향도 확인
- 관련 의사결정/이슈/지식 검색
- 세션 종료 시 작업 요약 기록

### 코드베이스 스캔

| 깊이 | 추출 내용 | 용도 |
|------|----------|------|
| `module` (기본) | 파일 수준 import 그래프 | 영향도 분석, 의존성 추적 |
| `symbol` | 클래스, 인터페이스, 함수, 메서드, 호출 그래프 | 심층 코드 이해 |

**심볼 스캔 지원 언어:**

| 언어 | 엔진 |
|------|------|
| TypeScript/JavaScript | ts-morph |
| Python | Tree-sitter |
| Go | Tree-sitter |
| Rust | Tree-sitter |
| Java | Tree-sitter |
| Swift | Tree-sitter |

심볼 스캔 선택적 의존성:

```bash
npm install ts-morph                          # TypeScript/JavaScript
npm install web-tree-sitter tree-sitter-wasms # Python, Go, Rust, Java, Swift
```

### RDF 인프라

내부적으로 OpenTology는 완전한 RDF/SPARQL 툴킷입니다:

- **RDFS 추론** — 데이터 푸시 시 자동 추론 (subClassOf, domain, range)
- **SHACL 검증** — 푸시마다 형상 제약 자동 검증
- **두 가지 스토리지 모드** — 임베디드 (WASM, Docker 불필요) 또는 HTTP (Oxigraph 서버)
- **인터랙티브 시각화** — 그래프 탐색 웹 UI (`opentology context graph`)
- **Named graph 스코핑** — 쿼리가 프로젝트에 자동 한정

```bash
# RDFS 추론 포함 데이터 푸시
opentology push ontology.ttl

# 접두사 자동 삽입 SPARQL 쿼리
opentology query 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10'

# 스키마 시각화
opentology viz schema

# 건강 진단
opentology doctor
```

### CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `context init` | 프로젝트 컨텍스트 초기화 (그래프 + 훅 + CLAUDE.md) |
| `context scan` | 코드베이스를 지식 그래프로 스캔 |
| `context load` | 최근 세션, 미해결 이슈, 의사결정 로드 |
| `context impact` | 파일 변경의 폭발 반경 분석 |
| `context sync` | git 이력에서 세션 복구, 모듈 재스캔 |
| `context graph` | 인터랙티브 시각화 웹 UI 시작 |
| `init` | RDF 프로젝트 초기화 |
| `push` | SHACL 검증 + RDFS 추론 포함 트리플 푸시 |
| `query` | SPARQL 쿼리 실행 |
| `validate` | Turtle 문법 및 SHACL 검증 |
| `pull` | 그래프를 Turtle로 내보내기 |
| `diff` | 로컬 파일과 그래프 비교 |
| `delete` | 파일/패턴으로 트리플 삭제 |
| `drop` | 그래프 전체 삭제 |
| `infer` | RDFS 물질화 실행/정리 |
| `graph` | Named graph 관리 |
| `status` | 트리플 수 표시 |
| `doctor` | 프로젝트 건강 진단 |
| `mcp` | MCP 서버 시작 |

### MCP 도구 (23개)

| 도구 | 설명 |
|------|------|
| `context_init` | 프로젝트 컨텍스트 그래프 초기화 |
| `context_load` | 프로젝트 컨텍스트 로드 (세션, 이슈, 의사결정) |
| `context_scan` | 코드베이스 스캔 (모듈/심볼 수준) |
| `context_impact` | 파일 수정 영향도 분석 |
| `context_sync` | git 이력에서 자동 동기화 |
| `context_status` | 컨텍스트 초기화 상태 확인 |
| `context_graph` | 인터랙티브 그래프 시각화 시작 |
| `init` | RDF 프로젝트 초기화 |
| `push` | 트리플 검증 및 푸시 |
| `query` | SPARQL 쿼리 실행 |
| `validate` | Turtle 내용 검증 |
| `pull` | 그래프를 Turtle로 내보내기 |
| `drop` | 프로젝트 그래프 삭제 |
| `delete` | 트리플 삭제 |
| `diff` | 로컬 파일과 그래프 비교 |
| `schema` | 온톨로지 스키마 조회 |
| `infer` | RDFS 추론 실행 |
| `graph_list` | Named graph 목록 |
| `graph_create` | Named graph 생성 |
| `graph_drop` | Named graph 삭제 |
| `visualize` | 스키마 다이어그램 생성 (Mermaid/DOT) |
| `status` | 프로젝트 상태 조회 |
| `doctor` | 프로젝트 건강 진단 |

### 시스템 요구사항

- **Node.js** >= 20.0.0
- **oxigraph**는 WebAssembly를 사용하므로 Node.js가 실행되는 모든 환경에서 동작합니다

### 기술 스택

- TypeScript, Oxigraph WASM, N3.js, commander.js
- @modelcontextprotocol/sdk (MCP 서버)
- shacl-engine (SHACL 검증)
- ts-morph (선택) TypeScript 심볼 분석
- web-tree-sitter + tree-sitter-wasms (선택) 다중 언어 분석

### 로드맵

- [x] 전체 RDF 생애주기 CLI (18개 명령어)
- [x] MCP 서버 (23개 도구 + 1개 리소스)
- [x] RDFS 추론 (자동 물질화)
- [x] SHACL 검증
- [x] 임베디드 모드 (Docker 불필요)
- [x] 프로젝트 컨텍스트 그래프 (의사결정, 이슈, 세션)
- [x] 코드베이스 스캔 (모듈 + 심볼 수준, 6개 언어)
- [x] 의존성 추적 기반 영향도 분석
- [x] git 이력에서 자동 동기화
- [x] CLAUDE.md 주입을 통한 AI 행동 지침
- [x] 인터랙티브 그래프 시각화 웹 UI
- [ ] OWL 추론 (owl:sameAs, owl:inverseOf)
- [ ] 원격 온톨로지 임포트
- [ ] 온톨로지 스냅샷 버전 관리

### 기여 방법

1. 저장소를 포크합니다
2. 기능 브랜치를 만듭니다 (`git checkout -b feature/my-feature`)
3. 변경사항을 커밋합니다
4. Pull Request를 열어주세요

### 라이선스

MIT
