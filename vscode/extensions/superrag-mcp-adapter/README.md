# SuperRAG MCP Adapter (VS Code)

Minimal VS Code extension that helps register and test a local SuperRAG MCP endpoint.

Commands

- `SuperRAG: Register MCP Server` — prompts for the MCP base URL and saves it to workspace settings (`superragMcp.serverUrl`).
- `SuperRAG: Test MCP Server` — sends a test `POST /query/agent` request and prints the response to the `SuperRAG MCP` output channel.

Quick start (development)

1. Open this repository in VS Code.
2. Run the Extension Development Host (F5) with the `vscode/extensions/superrag-mcp-adapter` folder as the development path.
3. In the Extension Development Host window, run the command `SuperRAG: Register MCP Server` and set `http://localhost:3000` (or your API URL).
4. Run `SuperRAG: Test MCP Server` and inspect the `SuperRAG MCP` output channel.

Notes

- This is a minimal adapter to get you started; extend it to integrate MCP responses into custom UI, completion providers or other automation.
- To load the extension outside dev mode, package/publish it or install from the generated `.vsix` (not included).
