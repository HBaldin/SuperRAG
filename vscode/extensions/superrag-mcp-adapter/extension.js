const vscode = require('vscode');
const http = require('http');
const https = require('https');

/**
 * Activate the extension.
 * Commands:
 *  - superrag.registerMcp : prompt for MCP URL and save to workspace settings
 *  - superrag.testMcp     : post a test query to /query/agent and show output
 */
function activate(context) {
  const registerCmd = vscode.commands.registerCommand('superrag.registerMcp', async () => {
    const cfg = vscode.workspace.getConfiguration();
    const current = cfg.get('superragMcp.serverUrl') || 'http://localhost:3000';
    const value = await vscode.window.showInputBox({
      prompt: 'SuperRAG MCP base URL',
      value: current,
      ignoreFocusOut: true
    });
    if (!value) return;
    await cfg.update('superragMcp.serverUrl', value, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`SuperRAG MCP server set to ${value}`);
  });

  const testCmd = vscode.commands.registerCommand('superrag.testMcp', async () => {
    const cfg = vscode.workspace.getConfiguration();
    const base = cfg.get('superragMcp.serverUrl') || 'http://localhost:3000';
    const out = vscode.window.createOutputChannel('SuperRAG MCP');
    out.show(true);
    out.appendLine(`Using server: ${base}`);

    try {
      const bodyObj = { query: 'agent health check', maxTokens: 2000 };
      const url = new URL('/query/agent', base).toString();
      out.appendLine(`POST ${url}`);
      const res = await postJson(url, bodyObj);
      out.appendLine('Response:');
      out.appendLine(JSON.stringify(res, null, 2));
      vscode.window.showInformationMessage('SuperRAG MCP test completed — see output channel.');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      vscode.window.showErrorMessage('SuperRAG MCP test failed: ' + msg);
    }
  });

  context.subscriptions.push(registerCmd, testCmd);
}

function deactivate() {}

function postJson(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const lib = url.protocol === 'https:' ? https : http;
      const body = JSON.stringify(bodyObj);
      const opts = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const ct = res.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (e) {
              resolve({ statusCode: res.statusCode, body: data });
            }
          } else {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { activate, deactivate };
