# Plan — Stability / Risk Fixes

## Goal
Stabilize OpenTology’s core workflows by fixing the highest-impact “Risks” identified in the audit:
- Version reporting drift (CLI vs package vs MCP)
- Hook + Claude settings install/repair reliability (doctor warning)
- Git boundary noise ("fatal: not a git repository" leaking to users/tests)
- Stubbed language detection causing unnecessary work (deep-scan)
- Silent failures / low observability at key seams

## Non-goals
- Implement roadmap features (OWL reasoning, remote ontology import, ontology snapshot versioning)
- Add new MCP tools or change tool schemas
- Create commits / push / PR (unless user explicitly requests later)

## Changes (by priority)

### P0 — Version coherence
1) Unify version source of truth:
   - CLI `opentology --version` must reflect `package.json` version.
   - MCP server `{ name, version }` must match `package.json` version.
2) Add a unit test that asserts reported versions equal `package.json`.

Files likely touched:
- `src/index.ts`
- `src/mcp/server.ts`
- `tests/unit/*` (new test)

### P0 — Git boundary: no stderr fatals
3) Deep scan file discovery must not leak git errors:
   - Before `git -C <root> ls-files ...`, detect git-work-tree reliably.
   - Use a helper that executes git with stderr captured and returns a boolean.
   - Ensure fallback path is taken cleanly (no user-facing fatals).

Files likely touched:
- `src/lib/deep-scanner.ts`
- (possibly) `src/lib/context-sync.ts` if it leaks git errors (it currently swallows, but verify behavior)

### P0 — Hook + settings reliability
4) Make `context init` / `doctor` alignment deterministic:
   - Identify what `doctor` checks for “SessionStart / PreToolUse” hooks.
   - Ensure `context_init` installs/repairs the required `.claude/settings.json` entries idempotently.
   - Ensure `doctor` distinguishes “hooks files exist” vs “Claude settings wired”.

Files likely touched:
- `src/lib/doctor.ts`
- `src/mcp/handlers/context.ts` (context_init)
- `src/templates/*-hook.ts` (only if wiring behavior is wrong)

### P1 — Deep scan: implement `detectLanguages()` (remove stub)
5) Implement lightweight language detection:
   - Scan for presence of supported extensions (ts/tsx/js/jsx/py/go/rs/java/swift) with an early-exit walk.
   - Filter extractors to only those with matching file presence.
   - Keep the explicit `options.languages` override behavior.

Files likely touched:
- `src/lib/deep-scanner.ts`

### P1 — Silent catch → explicit warnings (minimal observability)
6) Replace silent failure in key user-facing results with warnings:
   - `context_load` meta triple counts: if counts fail, return a warning string.
   - `graph-server` schema refresh failures: surface a warning (log or explicit status) instead of swallowing.

Files likely touched:
- `src/mcp/handlers/context.ts`
- `src/lib/graph-server.ts`

## Verification

### Global
- Run `npm run build`
- Run `npm test`

### Task 1–2: Version coherence
**Steps**
1) `node dist/index.js --version` prints exactly `package.json` `version`
2) Unit test asserts `getPackageVersion()` equals `package.json` `version`
3) Unit test asserts MCP server version field equals `package.json` `version`

**Expected**
- No hardcoded version strings remain for CLI/MCP
- CLI and MCP report the same version

### Task 3: Git boundary (no stderr fatals)
**Steps**
1) In vitest, run `deepScan(tempDirWithoutGit)` while intercepting `process.stderr.write`
2) Assert stderr does **not** contain `fatal: not a git repository`

**Expected**
- Deep scan gracefully falls back when not in a git work tree
- No user-visible git fatal output

### Task 4: Hook + settings reliability
**Steps**
1) Create a temp project dir with `.opentology/hooks/*.mjs` present but without `.claude/settings.json`
2) Run `context_init` and verify `.claude/settings.json` contains:
   - `hooks.SessionStart` command `node .opentology/hooks/session-start.mjs`
   - `hooks.PreToolUse` matcher `Edit|Write` command `node .opentology/hooks/pre-edit.mjs`
3) Run `runDoctor()` and verify `Settings` check is `ok`

**Expected**
- `context_init` is idempotent and self-healing
- `doctor` output matches the on-disk reality

### Task 5: detectLanguages filtering
**Steps**
1) Create a temp project dir with only `.py` files present
2) Run `deepScan(tempDir)` and verify only Python extractor is attempted (via warnings/metrics or by ensuring TS extractor does not produce availability warnings)

**Expected**
- Deep scan does not waste time on irrelevant extractors

### Task 6: Warnings/observability
**Steps**
1) Force `getGraphTripleCount` to throw (mock adapter or use an invalid graph URI) and verify `context_load` includes a warning instead of silently returning `0`
2) In graph UI, force `/api/schema` to fail and confirm a visible warning is emitted (console warning at minimum)

**Expected**
- Failures are visible and actionable, not silent

## Rollback/Safety
- Keep changes small and localized.
- Avoid changing public MCP tool schemas.
- No commits will be created during this execution (unless explicitly requested).
