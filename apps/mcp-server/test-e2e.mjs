/**
 * ToolPilot MCP Server — End-to-End Test
 * Spawns the MCP server as a child process, sends JSON-RPC messages via stdin,
 * reads responses from stdout, and validates each tool.
 *
 * Usage:
 *   node --env-file=../../.env test-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Colour helpers ────────────────────────────────────────────────────────
const _C = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};
const ok = (_msg) => ;
const fail = (_msg) => ;
const info = (_msg) => ;
const title = (_msg) => ;

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────
let msgId = 1;
function buildRequest(method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', id: msgId++, method, params })}\n`;
}

// ─── MCP Server process ─────────────────────────────────────────────────────
const serverPath = join(__dirname, 'dist', 'index.js');
const server = spawn('node', [serverPath], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let outputBuffer = '';
const pendingRequests = new Map();

server.stdout.on('data', (chunk) => {
  outputBuffer += chunk.toString();
  const lines = outputBuffer.split('\n');
  outputBuffer = lines.pop(); // keep incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        resolve(msg);
      }
    } catch {
      /* not JSON — MCP initialisation traffic, ignore */
    }
  }
});

server.stderr.on('data', (d) => {
  // pino logs go to stderr — only show warnings/errors
  try {
    const entry = JSON.parse(d.toString().trim());
    if (entry.level >= 50) console.error(`[server error] ${entry.msg}`, entry.err ?? '');
  } catch {
    /* raw stderr */
  }
});

server.on('error', (e) => {
  console.error('Server spawn error:', e);
  process.exit(1);
});
server.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`Server exited with code ${code}`);
});

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId;
    const req = buildRequest(method, params);
    pendingRequests.set(id, { resolve, reject });
    server.stdin.write(req);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 15000);
  });
}

// ─── Test harness ───────────────────────────────────────────────────────────
let _passed = 0;
let failed = 0;

function assert(condition, description, detail = '') {
  if (condition) {
    ok(description);
    _passed++;
  } else {
    fail(`${description}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function callTool(toolName, args) {
  const res = await send('tools/call', { name: toolName, arguments: args });
  if (res.error) throw new Error(`RPC error ${res.error.code}: ${res.error.message}`);
  const content = res.result?.content?.[0]?.text;
  if (!content) throw new Error('No content in response');
  return JSON.parse(content);
}

// ─── Test runner ────────────────────────────────────────────────────────────
async function run() {
  // Give server a moment to start
  await new Promise((r) => setTimeout(r, 1000));

  // ── 1. MCP handshake ──────────────────────────────────────────────────────
  title('MCP Handshake');
  const initRes = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  assert(initRes.result?.serverInfo?.name === 'toolpilot', 'Server name is "toolpilot"');

  const toolsRes = await send('tools/list', {});
  const toolNames = toolsRes.result?.tools?.map((t) => t.name) ?? [];
  info(`Registered tools: ${toolNames.join(', ')}`);
  assert(toolNames.includes('search_tools'), 'search_tools registered');
  assert(toolNames.includes('search_tools_respond'), 'search_tools_respond registered');
  assert(toolNames.includes('get_stack'), 'get_stack registered');
  assert(toolNames.includes('report_outcome'), 'report_outcome registered');
  assert(toolNames.includes('check_issue'), 'check_issue registered');
  assert(toolNames.includes('check_compatibility'), 'check_compatibility registered');
  assert(toolNames.length === 6, `All 6 tools registered (got ${toolNames.length})`);

  // ── 2. get_stack ──────────────────────────────────────────────────────────
  title('Tool: get_stack');
  try {
    const r = await callTool('get_stack', { use_case: 'web framework', limit: 5 });
    info(`get_stack result: ok=${r.ok}`);
    assert(r.ok === true, 'get_stack returns ok:true');
    assert(Array.isArray(r.data?.tools), 'Response contains tools array');
    const count = r.data?.tools?.length ?? 0;
    assert(count > 0, `Returns at least 1 tool (got ${count})`);
    if (count > 0) {
      const t = r.data.tools[0];
      assert(typeof t.name === 'string', `First tool has name: "${t.name}"`);
      assert(typeof t.description === 'string', 'First tool has description');
      info(`Top result: ${t.name} — ${t.description?.slice(0, 60)}…`);
    }
  } catch (e) {
    fail(`get_stack threw: ${e.message}`);
    failed++;
  }

  // ── 3. search_tools ───────────────────────────────────────────────────────
  title('Tool: search_tools (new session)');
  let queryId = null;
  try {
    const r = await callTool('search_tools', {
      query: 'fast TypeScript HTTP framework',
      user_id: 'test',
    });
    info(`search_tools result: ok=${r.ok}, has clarification=${!!r.data?.clarification_questions}`);
    assert(r.ok === true, 'search_tools returns ok:true');
    queryId = r.data?.query_id;
    assert(typeof queryId === 'string', `Returns query_id: ${queryId?.slice(0, 8)}…`);
    if (r.data?.clarification_questions) {
      info(`Got ${r.data.clarification_questions.length} clarification question(s)`);
      assert(r.data.clarification_questions.length > 0, 'Clarification questions returned');
    } else if (r.data?.results) {
      info(`Got ${r.data.results.length} direct result(s)`);
      assert(r.data.results.length > 0, 'Direct results returned');
      if (r.data.results[0]) info(`Top result: ${r.data.results[0].name}`);
    }
  } catch (e) {
    fail(`search_tools threw: ${e.message}`);
    failed++;
  }

  // ── 4. search_tools_respond (if we have a session) ────────────────────────
  if (queryId) {
    title('Tool: search_tools_respond');
    try {
      const r = await callTool('search_tools_respond', {
        query_id: queryId,
        answers: [{ dimension: 'category', value: 'http-framework' }],
      });
      info(`search_tools_respond result: ok=${r.ok}, done=${r.data?.done}`);
      assert(r.ok === true, 'search_tools_respond returns ok:true');
      assert(typeof r.data?.done === 'boolean', 'Response has done field');
    } catch (e) {
      fail(`search_tools_respond threw: ${e.message}`);
      failed++;
    }
  }

  // ── 5. get_stack with constraints ─────────────────────────────────────────
  title('Tool: get_stack (with constraints)');
  try {
    const r = await callTool('get_stack', {
      use_case: 'database',
      constraints: { language: 'typescript' },
      limit: 3,
    });
    assert(r.ok === true, 'get_stack with constraints returns ok:true');
    info(`DB tools: ${r.data?.tools?.map((t) => t.name).join(', ') ?? 'none'}`);
  } catch (e) {
    fail(`get_stack (constrained) threw: ${e.message}`);
    failed++;
  }

  // ── 6. check_issue (stub) ─────────────────────────────────────────────────
  title('Tool: check_issue (Phase 5 stub)');
  try {
    const r = await callTool('check_issue', {
      tool_name: 'next.js',
      issue_title: 'app router memory leak',
    });
    info(`check_issue result: ok=${r.ok}, error=${r.error}`);
    assert(r.ok === false, 'check_issue correctly returns ok:false (stub)');
    assert(r.error === 'not_yet_implemented', 'Returns not_yet_implemented error code');
  } catch (e) {
    fail(`check_issue threw: ${e.message}`);
    failed++;
  }

  // ── 7. check_compatibility (stub) ─────────────────────────────────────────
  title('Tool: check_compatibility (Phase 5 stub)');
  try {
    const r = await callTool('check_compatibility', {
      tool_a: 'next.js',
      tool_b: 'prisma',
    });
    info(`check_compatibility result: ok=${r.ok}, error=${r.error}`);
    assert(r.ok === false, 'check_compatibility correctly returns ok:false (stub)');
    assert(r.error === 'not_yet_implemented', 'Returns not_yet_implemented error code');
  } catch (e) {
    fail(`check_compatibility threw: ${e.message}`);
    failed++;
  }

  // ── 8. report_outcome ─────────────────────────────────────────────────────
  if (queryId) {
    title('Tool: report_outcome');
    try {
      const r = await callTool('report_outcome', {
        query_id: queryId,
        chosen_tool: 'hono',
        outcome: 'success',
        reason: 'Fast and lightweight',
      });
      info(`report_outcome result: ok=${r.ok}`);
      // Prisma may fail (no DB) but the tool should still respond
      assert(typeof r.ok === 'boolean', 'report_outcome returns a result (ok field present)');
    } catch (e) {
      fail(`report_outcome threw: ${e.message}`);
      failed++;
    }
  }

  // ── 9. Input validation ───────────────────────────────────────────────────
  title('Input Validation');
  try {
    const r = await callTool('search_tools', { query: '' }); // empty query should fail Zod
    assert(r.ok === false, 'Empty query returns ok:false (Zod validation)');
    info(`Validation error: ${r.error ?? r.message}`);
  } catch (e) {
    // An RPC error is also acceptable here
    ok(`Empty query rejected (RPC error: ${e.message.slice(0, 50)})`);
    _passed++;
  }

  server.stdin.end();
  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner crashed:', e);
  server.kill();
  process.exit(1);
});
