Before scanning, ask the user which scan depth they want:

1. **Module scan** (default) — fast, file-level analysis. Returns directory tree, entry points, detected imports, and dependency graph. Good for a quick project overview.
2. **Deep scan** (symbol) — slower, extracts classes, interfaces, functions, and method calls using ts-morph (TypeScript) or Tree-sitter (Go, Python, Rust, Java, Swift). Auto-pushes symbol triples to the context graph. Use when you need detailed architectural understanding.

Once the user chooses (or accepts the default), call the context_scan MCP tool with the appropriate `depth` parameter ("module" or "symbol").

After the scan completes, analyze the results and create Knowledge triples to push via `push`:
- **Project triple** (`otx:Project`): name, description, tech stack, status "active"
- **Knowledge triples** (`otx:Knowledge`): architectural patterns, framework choices, build setup, project structure

Push to the **context** graph (use graph name "context"). Keep each push under 100 triples.
