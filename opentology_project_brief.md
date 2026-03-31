# OpenTology — Claude Code 인수인계 문서

> CLI로 관리하는 RDF/SPARQL 인프라 플랫폼 — Supabase가 Postgres를 관리하듯, OpenTology가 RDF를 관리한다

---

## 프로젝트 배경

### 왜 만드는가

- 기존 온톨로지 툴(TypeDB, TerminusDB, Fuseki)은 DX가 너무 나쁘고 일반 개발자 진입 장벽이 높음
- RDF/SPARQL 기반 managed 서비스가 존재하지 않음
- **"Supabase for RDF"** — CLI 하나로 SPARQL 엔드포인트를 바로 쓸 수 있는 managed 인프라가 필요하다

### 핵심 철학

Supabase의 창업 원칙과 동일:
> "개발자 도구의 위험은 사용자가 내부에서 무슨 일이 일어나는지 이해할 수 없을 때다"

- SPARQL 엔드포인트를 그대로 노출 (블랙박스 없음)
- 개발자가 Turtle/SPARQL을 작성하고, OpenTology가 그 데이터를 받아 저장·관리·조회하는 인프라 레이어를 제공한다

### 전략

Supabase 초기 전략과 동일하게:
1. CLI 도구 구현
2. GitHub 오픈소스 공개
3. HackerNews 던지기
4. Star & 피드백 수집
5. 수요 확인 후 서비스화 (클라우드, 대시보드, Auth)
6. MCP 연동

---

## 핵심 개념 정리

### RDF (Resource Description Framework)

모든 데이터를 **주어-술어-목적어** 트리플로 표현:

```
윤겸 - 만들었다 - COCSO
COCSO - 종류이다 - B2B SaaS
```

모든 개념은 URI로 표현 (전 세계 유일성 보장):

```turtle
@prefix ex: <https://myapp.com/> .
@prefix schema: <http://schema.org/> .

ex:yoonkyum schema:founder ex:cocso .
ex:cocso a schema:SoftwareApplication .
```

### Named Graph

트리플 묶음에 이름을 붙여 격리 — **멀티테넌시의 핵심**:

```turtle
GRAPH <https://db.myplatform.com/tenant/userA/project1> {
  ex:yoonkyum schema:founder ex:cocso .
}

GRAPH <https://db.myplatform.com/tenant/userB/project1> {
  ex:john schema:founder ex:startup .
}
```

물리적으로 Oxigraph 하나지만, 그래프 이름으로 테넌트 데이터 완전 격리.

### SPARQL

RDF를 쿼리하는 언어. SQL과 1:1 대응:

```sparql
SELECT ?name
FROM NAMED <https://db.myplatform.com/tenant/userA/project1>
WHERE {
  GRAPH <https://db.myplatform.com/tenant/userA/project1> {
    ?person a ex:Person .
    ?person ex:name ?name .
  }
}
```

### Turtle

RDF 데이터를 표현하는 포맷. 사람이 읽기 쉬운 텍스트 형식으로 온톨로지를 정의한다.

---

## MVP 범위

**목표: CLI 기반 워크플로를 완성된 오픈소스로 GitHub에 올리기**

### CLI 커맨드

| 커맨드 | 설명 |
|--------|------|
| `opentology init` | 새 OpenTology 프로젝트 초기화 (설정 파일 생성, 네임스페이스 설정) |
| `opentology push <file.ttl>` | Turtle 파일을 검증하고 Oxigraph Named Graph에 푸시 |
| `opentology query <sparql>` | 프로젝트의 Named Graph 스코프 안에서 SPARQL 쿼리 실행 |
| `opentology status` | 현재 프로젝트 상태 출력 (그래프 URI, 트리플 수, 마지막 푸시 시각) |
| `opentology validate <file.ttl>` | 푸시 없이 Turtle 문법만 검증 |
| `opentology pull` | 현재 Named Graph를 Turtle 파일로 내보내기 |

### 워크플로 다이어그램

```
개발자가 Turtle 작성 (AI 어시스턴트 활용 또는 직접 작성)
    ↓
opentology validate → 문법 검증
    ↓
opentology push → Oxigraph Named Graph에 저장
    ↓
opentology query → SPARQL 결과 확인
```

대시보드 없음. REST API 없음. GraphQL 없음. **이것만**.

---

## 전체 아키텍처 (서비스화 이후 목표)

| 레이어 | 구성 |
|--------|------|
| Client | **CLI (`opentology`)**, Dashboard (future), SDK (future), MCP server (future) |
| Gateway | Clerk auth, Rate limiting |
| API | REST API, GraphQL, SPARQL |
| Services | Tenant manager, Schema service, Query engine, **Turtle validator** |
| Storage | Oxigraph RDF, Postgres (metadata) |

---

## 기술 스택 결정

| 항목 | 결정 | 이유 |
|------|------|------|
| RDF 엔진 | **Oxigraph** | Rust 기반 경량, 단일 바이너리, SPARQL 1.1 지원 |
| 멀티테넌시 | **Named Graph** | 논리적 격리, MVP에 적합 |
| 백엔드 | **Node.js + TypeScript** | 기존 스택, Oxigraph JS 클라이언트 있음 |
| API | REST + GraphQL + SPARQL | SPARQL은 파워유저용 |
| Auth | **Clerk** | 외부 서비스로 빠르게 |
| CLI 프레임워크 | **oclif 또는 commander.js** | CLI 구조화 |
| Turtle 검증 | **n3.js 또는 커스텀 파서** | push 전 검증 |
| 호스팅 | 클라우드 only | Supabase 모델 |

---

## 현재 진행 상태

### 완료
- [x] Oxigraph Docker로 로컬 실행
- [x] Named Graph에 트리플 INSERT 확인
- [x] SPARQL로 Named Graph 데이터 조회 확인

### 실행 명령어 (검증 완료)

```bash
# Oxigraph 실행
docker run -p 7878:7878 ghcr.io/oxigraph/oxigraph serve --location /data --bind 0.0.0.0:7878

# 트리플 삽입
curl -X POST http://localhost:7878/update \
  -H 'Content-Type: application/sparql-update' \
  -d '
INSERT DATA {
  GRAPH <https://myapp.com/test> {
    <https://myapp.com/yoonkyum> <http://schema.org/name> "윤겸" .
    <https://myapp.com/yoonkyum> <http://schema.org/founder> <https://myapp.com/cocso> .
  }
}'

# 조회
curl http://localhost:7878/query \
  -H 'Content-Type: application/sparql-query' \
  -d '
SELECT ?s ?p ?o
FROM NAMED <https://myapp.com/test>
WHERE {
  GRAPH <https://myapp.com/test> {
    ?s ?p ?o
  }
}'
```

---

## 다음 할 일 (Claude Code가 진행할 것)

### Step 1. CLI 프로젝트 초기화

```bash
mkdir opentology && cd opentology
npm init -y
npm install typescript ts-node @types/node
npm install commander  # 또는 oclif
```

### Step 2. `opentology init` 구현

- 설정 파일(`.opentology.yaml` 또는 `.opentology.json`) 생성
- 프로젝트 네임스페이스, Oxigraph 엔드포인트 URL 설정
- Named Graph URI 자동 생성: `https://opentology.dev/tenant/{tenantId}/{projectId}`

### Step 3. `opentology validate` 구현

- Turtle 파일 파싱 및 문법 검증
- n3.js 또는 커스텀 파서 활용

### Step 4. `opentology push` 구현

- validate 통과 후 SPARQL UPDATE로 Oxigraph에 저장
- Named Graph URI 자동 매핑

### Step 5. `opentology query` 구현

- SPARQL 쿼리를 해당 Named Graph 스코프 안에서 실행
- 결과를 테이블/JSON으로 포맷팅

### Step 6. `opentology status` / `opentology pull` 구현

- 현재 그래프 상태 조회
- 트리플 데이터 Turtle 포맷으로 내보내기

---

## 엣지 포인트 (주의사항)

- **SPARQL 인젝션**: 사용자 쿼리 파싱해서 다른 Named Graph 접근 차단 필요
- **Blank Node 문제**: 외부 RDF 임포트 시 ID 충돌 가능
- **Turtle 유효성 검증**: 외부에서 생성된 Turtle이 문법 오류일 수 있으므로 파싱 검증 후 저장
- **Oxigraph 단일 프로세스**: 스케일링 시 Named Graph → 인스턴스 격리로 전환 경로 필요
- **CLI 설정 파일 보안**: `.opentology.yaml`에 엔드포인트 URL이 포함되므로 `.gitignore` 처리 권장
- **오프라인 모드**: `validate` 커맨드는 Oxigraph 없이도 동작해야 함 (로컬 파싱 전용)

---

## 레퍼런스

- [Oxigraph GitHub](https://github.com/oxigraph/oxigraph)
- [Oxigraph Docker](https://ghcr.io/oxigraph/oxigraph)
- [SPARQL 1.1 스펙](https://www.w3.org/TR/sparql11-query/)
- [commander.js](https://github.com/tj/commander.js)
- [oclif](https://oclif.io)
- [n3.js](https://github.com/rdfjs/N3.js)
