/**
 * MCP stdio integration test — the full chain a real agent exercises:
 * CLI entry (dist/cli/index.js mcp) → stdio JSON-RPC transport → MCP SDK
 * server → Engine allowlist guard → clean tool error (isError: true).
 *
 * Runs against the built dist/ bundle (CI builds before testing); when no
 * build exists (bare `npx vitest run` on a fresh checkout) the suite skips —
 * spawning TypeScript sources with node directly is not possible.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DIST_ENTRY = path.resolve('dist/cli/index.js');
const suite = fs.existsSync(DIST_ENTRY) ? describe : describe.skip;

let workspace: string;
let repoA: string;
let repoB: string;
let aegisxHome: string;
let client: Client | null = null;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-stdio-'));
  repoA = path.join(workspace, 'repo-a');
  repoB = path.join(workspace, 'repo-b');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  aegisxHome = path.join(workspace, 'home');
  fs.writeFileSync(path.join(repoA, 'a.ts'), 'export function alpha() {}\n');
  fs.writeFileSync(path.join(repoB, 'b.ts'), 'export function beta() {}\n');
});

afterEach(async () => {
  if (client !== null) {
    await client.close();
    client = null;
  }
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Spawn the real MCP server with the allowlist env and connect a real client.
 *  cwd = the allowlisted repo, exactly as an agent spawns the server from the
 *  project it works on (cwd-derived repo hints then resolve to an allowed repo). */
async function connectServer(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY, 'mcp'],
    cwd: repoA,
    env: {
      ...process.env,
      AEGISX_HOME: aegisxHome,
      AEGISX_ALLOWED_REPOS: repoA,
    } as Record<string, string>,
  });
  const c = new Client({ name: 'vitest-stdio-probe', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

suite('mcp stdio — allowlist denial over the wire', () => {
  it('protocol: the server registers all five memory tools', async () => {
    client = await connectServer();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['aegisxmemory_graph', 'aegisxmemory_index', 'aegisxmemory_recall', 'aegisxmemory_remember', 'aegisxmemory_save']);
  });

  it('negative: indexing a non-allowlisted repo returns a clean tool error (no crash)', async () => {
    client = await connectServer();
    const result = (await client.callTool({
      name: 'aegisxmemory_index',
      arguments: { path: repoB },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not in AEGISX_ALLOWED_REPOS');
    // The denial is the tool's answer, not a transport failure: the very next
    // call still works — the server process is alive and healthy.
    const followUp = (await client.callTool({
      name: 'aegisxmemory_index',
      arguments: { path: repoA },
    })) as ToolResult;
    expect(followUp.isError).toBeUndefined();
    expect(followUp.content[0]?.text).toContain('"filesTotal":1');
  });

  it('negative: recalling a non-allowlisted repo is denied the same way', async () => {
    client = await connectServer();
    const result = (await client.callTool({
      name: 'aegisxmemory_recall',
      arguments: { repo: repoB },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not in AEGISX_ALLOWED_REPOS');
  });

  it('happy: allowed repo indexes and recalls over stdio end-to-end', async () => {
    client = await connectServer();
    const remember = (await client.callTool({
      name: 'aegisxmemory_remember',
      arguments: { key: 'project.a.stack', value: 'stdio integration works' },
    })) as ToolResult;
    expect(remember.isError).toBeUndefined();
    expect(remember.content[0]?.text).toContain('saved project.a.stack');

    const recall = (await client.callTool({
      name: 'aegisxmemory_recall',
      arguments: { repo: repoA },
    })) as ToolResult;
    expect(recall.isError).toBeUndefined();
    expect(recall.content[0]?.text).toContain('AEGISX-MEMORY:BEGIN');
    expect(recall.content[0]?.text).toContain('stdio integration works');
  });

  it('happy: re-pinning a fact tells the agent which value it replaced', async () => {
    client = await connectServer();
    const first = (await client.callTool({
      name: 'aegisxmemory_remember',
      arguments: { key: 'project.a.dev-port', value: '3000' },
    })) as ToolResult;
    expect(first.content[0]?.text).toBe('saved project.a.dev-port');

    const second = (await client.callTool({
      name: 'aegisxmemory_remember',
      arguments: { key: 'project.a.dev-port', value: '5000' },
    })) as ToolResult;
    expect(second.content[0]?.text).toContain('replaced previous value: 3000');

    // The same signal must reach the context block the agent reads next session.
    const recall = (await client.callTool({
      name: 'aegisxmemory_recall',
      arguments: { repo: repoA },
    })) as ToolResult;
    expect(recall.content[0]?.text).toContain(
      '- [project.a.dev-port] 5000 — was: 3000 (changed ',
    );
  });

  it('backward compatible: a handoff with only the original four fields still saves', async () => {
    client = await connectServer();
    // The shape every agent knew before gotchas/conventions existed. If the new
    // fields were required, this call would start failing on upgrade.
    const saved = (await client.callTool({
      name: 'aegisxmemory_save',
      arguments: {
        goal: 'old-shaped handoff',
        facts: [],
        decisions: ['pin the dev server to port 5000'],
        nextSteps: [],
      },
    })) as ToolResult;
    expect(saved.isError).toBeUndefined();
    expect(saved.content[0]?.text).toContain('session handoff saved');
    expect(saved.content[0]?.text).toContain('1 note recorded');

    const recall = (await client.callTool({
      name: 'aegisxmemory_recall',
      arguments: { repo: repoA },
    })) as ToolResult;
    expect(recall.content[0]?.text).toContain('## Decisions, gotchas & conventions');
    expect(recall.content[0]?.text).toContain('- (decision) pin the dev server to port 5000');
  });

  it('happy: gotchas and conventions travel through the tool schema as their own kinds', async () => {
    client = await connectServer();
    const saved = (await client.callTool({
      name: 'aegisxmemory_save',
      arguments: {
        goal: 'notes with kinds',
        facts: [],
        decisions: [],
        gotchas: ['sqlite locking needs a busy timeout'],
        conventions: ['four spaces in TypeScript'],
        nextSteps: [],
      },
    })) as ToolResult;
    expect(saved.isError).toBeUndefined();
    expect(saved.content[0]?.text).toContain('2 notes recorded');

    const recall = (await client.callTool({
      name: 'aegisxmemory_recall',
      arguments: { repo: repoA },
    })) as ToolResult;
    const text = recall.content[0]?.text ?? '';
    expect(text).toContain('- (gotcha) sqlite locking needs a busy timeout');
    expect(text).toContain('- (convention) four spaces in TypeScript');
    // and the last handoff prints them under their own headings
    expect(text).toContain('Gotchas:\n- sqlite locking needs a busy timeout');
    expect(text).toContain('Conventions:\n- four spaces in TypeScript');
  });
});
