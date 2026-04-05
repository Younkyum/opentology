Use the context_graph MCP tool to start an interactive graph visualization web server.

The tool starts a local web server and returns a URL. Tell the user:
1. The URL to open in their browser (e.g. http://localhost:PORT)
2. They can explore classes, instances, and relationships visually
3. The sidebar has a SPARQL query box for custom queries
4. Click any node to see its properties
5. Use the graph selector dropdown to switch between named graphs
6. Press Ctrl+C in the terminal to stop the server

If context is not initialized, suggest running /context-init first.
