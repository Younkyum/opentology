# OpenTology

> CLI-managed RDF/SPARQL infrastructure -- Supabase for RDF

[English](#english) | [한국어](#한국어)

---

## English

Existing ontology tools have terrible developer experience. OpenTology gives you managed RDF with a simple CLI -- initialize a project, write Turtle, validate, push, and query, all from your terminal. It also ships an MCP server so your AI assistant can manage your knowledge graph directly.

### Quick Demo

```bash
# Initialize project
opentology init my-project

# Write your ontology (or let your AI assistant do it)
cat > schema.ttl << 'EOF'
@prefix ex: <https://example.org/> .
@prefix schema: <http://schema.org/> .
ex:doctor a schema:Person ;
  schema:name "Dr. Kim" ;
  schema:worksFor ex:hospital .
EOF

# Validate, push, query
opentology validate schema.ttl
opentology push schema.ttl
opentology query 'SELECT ?name WHERE { ?s schema:name ?name }'
```

### Features

- **6 CLI commands** -- init, validate, push, query, status, pull
- **Auto Named Graph scoping** -- no need to write `GRAPH <...>` in your queries
- **MCP Server** for AI agent integration (Claude Code, Cursor, etc.)
- **Turtle validation** before every push
- **Oxigraph-powered** -- Rust-based, fast, full SPARQL 1.1 support

### Installation

```bash
npm install -g opentology
```

### Prerequisites

- Node.js 18+
- Oxigraph running (Docker):

```bash
docker run -p 7878:7878 ghcr.io/oxigraph/oxigraph \
  serve --location /data --bind 0.0.0.0:7878
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `opentology init <project-id>` | Initialize a new project with config and named graph |
| `opentology validate <file>` | Validate Turtle syntax without pushing |
| `opentology push <file>` | Validate and insert triples into the project graph |
| `opentology query <sparql>` | Run a SPARQL query (auto-scoped to your project graph) |
| `opentology status` | Show project info and triple count |
| `opentology pull` | Export the entire project graph as Turtle |

### MCP Server / AI Agent Integration

Start the MCP server:

```bash
opentology mcp
```

Add to your Claude Code configuration (`.mcp.json`):

```json
{
  "mcpServers": {
    "opentology": {
      "command": "npx",
      "args": ["opentology", "mcp"]
    }
  }
}
```

The MCP server exposes 6 tools:

| Tool | Description |
|------|-------------|
| `opentology_init` | Initialize a project |
| `opentology_validate` | Validate Turtle content |
| `opentology_push` | Validate and push triples |
| `opentology_query` | Execute SPARQL queries (auto-scoped) |
| `opentology_status` | Get project status and triple count |
| `opentology_pull` | Export graph as Turtle |

Your AI assistant can directly push Turtle, run SPARQL queries, and manage your knowledge graph without leaving the conversation.

### How It Works

1. You (or your AI assistant) write Turtle RDF data
2. OpenTology validates the Turtle syntax
3. Triples are pushed to an Oxigraph Named Graph scoped to your project
4. SPARQL queries are automatically scoped to your project graph -- no manual `GRAPH <...>` needed
5. Export your data anytime with `pull`

### Tech Stack

- TypeScript, commander.js, n3.js
- @modelcontextprotocol/sdk for MCP server
- Oxigraph (Rust-based RDF triplestore, SPARQL 1.1)

### Roadmap

- [ ] Cloud hosted service
- [ ] Web dashboard
- [ ] SDK (JavaScript / Python)
- [ ] Auth and multi-tenancy
- [ ] MCP resource support

### Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Open a Pull Request

### License

MIT

---

## 한국어

기존 온톨로지 도구들은 개발자 경험이 좋지 않습니다. OpenTology는 간단한 CLI로 RDF를 관리할 수 있게 해줍니다. 프로젝트 초기화, Turtle 작성, 검증, 푸시, 쿼리까지 터미널에서 모두 처리합니다. MCP 서버도 내장되어 있어 AI 어시스턴트가 지식 그래프를 직접 다룰 수 있습니다.

### 빠른 시작

```bash
# 프로젝트 초기화
opentology init my-project

# 온톨로지 작성 (직접 또는 AI 어시스턴트에게 맡기기)
cat > schema.ttl << 'EOF'
@prefix ex: <https://example.org/> .
@prefix schema: <http://schema.org/> .
ex:doctor a schema:Person ;
  schema:name "Dr. Kim" ;
  schema:worksFor ex:hospital .
EOF

# 검증, 푸시, 쿼리
opentology validate schema.ttl
opentology push schema.ttl
opentology query 'SELECT ?name WHERE { ?s schema:name ?name }'
```

### 주요 기능

- **CLI 명령어 6개** -- init, validate, push, query, status, pull
- **Named Graph 자동 스코핑** -- 쿼리에 `GRAPH <...>`를 직접 쓸 필요 없음
- **MCP 서버** 내장으로 AI 에이전트 연동 (Claude Code, Cursor 등)
- **Turtle 문법 검증** 후 푸시
- **Oxigraph 기반** -- Rust로 작성된 고성능 SPARQL 1.1 트리플스토어

### 설치

```bash
npm install -g opentology
```

### 사전 요구사항

- Node.js 18+
- Oxigraph 실행 (Docker):

```bash
docker run -p 7878:7878 ghcr.io/oxigraph/oxigraph \
  serve --location /data --bind 0.0.0.0:7878
```

### CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `opentology init <project-id>` | 새 프로젝트 초기화 (설정 파일 및 Named Graph 생성) |
| `opentology validate <file>` | Turtle 문법 검증 (푸시 없이 확인만) |
| `opentology push <file>` | Turtle 검증 후 프로젝트 그래프에 트리플 삽입 |
| `opentology query <sparql>` | SPARQL 쿼리 실행 (프로젝트 그래프에 자동 스코핑) |
| `opentology status` | 프로젝트 정보 및 트리플 수 확인 |
| `opentology pull` | 프로젝트 그래프 전체를 Turtle로 내보내기 |

### MCP 서버 / AI 에이전트 연동

MCP 서버 실행:

```bash
opentology mcp
```

Claude Code 설정 (`.mcp.json`)에 추가:

```json
{
  "mcpServers": {
    "opentology": {
      "command": "npx",
      "args": ["opentology", "mcp"]
    }
  }
}
```

MCP 서버가 제공하는 6개 도구:

| 도구 | 설명 |
|------|------|
| `opentology_init` | 프로젝트 초기화 |
| `opentology_validate` | Turtle 내용 검증 |
| `opentology_push` | 트리플 검증 및 푸시 |
| `opentology_query` | SPARQL 쿼리 실행 (자동 스코핑) |
| `opentology_status` | 프로젝트 상태 및 트리플 수 조회 |
| `opentology_pull` | 그래프를 Turtle로 내보내기 |

AI 어시스턴트가 대화 중에 직접 Turtle을 푸시하고, SPARQL 쿼리를 실행하고, 지식 그래프를 관리할 수 있습니다.

### 동작 방식

1. 사용자(또는 AI 어시스턴트)가 Turtle RDF 데이터를 작성
2. OpenTology가 Turtle 문법을 검증
3. 트리플이 프로젝트 전용 Oxigraph Named Graph에 저장
4. SPARQL 쿼리는 프로젝트 그래프에 자동으로 스코핑 -- `GRAPH <...>` 직접 작성 불필요
5. `pull` 명령어로 언제든 데이터 내보내기 가능

### 기술 스택

- TypeScript, commander.js, n3.js
- @modelcontextprotocol/sdk (MCP 서버)
- Oxigraph (Rust 기반 RDF 트리플스토어, SPARQL 1.1)

### 로드맵

- [ ] 클라우드 호스팅 서비스
- [ ] 웹 대시보드
- [ ] SDK (JavaScript / Python)
- [ ] 인증 및 멀티테넌시
- [ ] MCP 리소스 지원

### 기여 방법

1. 저장소를 포크합니다
2. 기능 브랜치를 만듭니다 (`git checkout -b feature/my-feature`)
3. 변경사항을 커밋합니다
4. Pull Request를 열어주세요

### 라이선스

MIT
