/**
 * Hermes shell-hook installer — the deterministic memory loop for Hermes.
 *
 * The rules block asks the model to recall and save; Hermes hooks do not ask.
 * They are declared in `~/.hermes/config.yaml` under `hooks:` and executed by
 * the agent itself at fixed lifecycle points:
 *
 *   pre_llm_call → aegisx-recall.sh    first turn injects the recall block
 *                                      ({"context": …} per the Hermes plugin
 *                                      contract) before the model reads
 *                                      anything;
 *   pre_verify   → aegisx-save-nudge.sh when the agent edited code and is
 *                                      about to finish, one nudge returns
 *                                      {"action":"continue","message"} so it
 *                                      saves the handoff first.
 *
 * Scripts carry the same `aegisx-memory:*` markers the Claude installer uses,
 * so idempotence survives re-formatting of config.yaml by other tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { selfServerEntry } from './mcp-config.js';
import type { HookInstallResult } from './hooks.js';

/** The two lifecycle events Hermes understands that map to the memory loop.
 *  `pre_llm_call` may return `{"context": "…"}` (plugin dispatch contract);
 *  `pre_verify` accepts the Claude-style Stop payload or the plain action. */
export const HERMES_HOOK_EVENTS = ['pre_llm_call', 'pre_verify'] as const;
export type HermesHookEvent = (typeof HERMES_HOOK_EVENTS)[number];

/** Where the hook scripts live. Hermes ships its own agent-hooks dir for this. */
export function hermesAgentHooksDir(configFile: string, homeDir?: string): string {
  if (homeDir !== undefined) return path.join(homeDir, 'agent-hooks');
  // configFile is ~/.hermes/config.yaml (or $HERMES_HOME/config.yaml) — the
  // sibling directory keeps script + config together through HERMES_HOME moves.
  return path.join(path.dirname(configFile), 'agent-hooks');
}

function resolveBin(): string {
  const argv0 = process.argv[1] ?? '';
  const invokedAsBin = path.basename(argv0) === 'aegisxmemory.js' || path.basename(argv0) === 'aegisxmemory';
  return invokedAsBin ? 'aegisxmemory' : `node ${JSON.stringify(selfServerEntry())}`;
}

interface HookScriptSpec {
  file: string;
  event: HermesHookEvent;
  timeout: number;
  /** JSON-payload flag for the underlying `aegisxmemory hook …` call: the
   *  recall script must emit the exact {"context": …} injection shape. */
  json: boolean;
  body: string;
}

/** Build the two script texts. `bin` is injectable for tests; the marker
 *  comment rides in the script so detection is content-based, not name-based.
 *  The command is baked into the exec line itself — no shell variable
 *  indirection: inside `sh`, `BIN=node "..."` parses as a temp-env prefix
 *  (running `node` with the path as argv), not an assignment, and the exec
 *  line would then lose the binary entirely. */
export function hermesHookScripts(bin?: string): HookScriptSpec[] {
  const cmd = bin ?? resolveBin();
  return [
    {
      file: 'aegisx-recall.sh',
      event: 'pre_llm_call',
      timeout: 15,
      json: true,
      body: `#!/usr/bin/env sh
# aegisx-memory:pre-llm-call — inject the project memory block into the first
# turn of every Hermes session. Reads the event JSON on stdin only to take its
# cwd; a missing or malformed body resolves the repo from process cwd instead.
# Contract (plugins_dispatch): stdout must be exactly one JSON object:
# {"context": "..."} — never logs, never a partial line.
exec 2>/dev/null
RAW=$(cat 2>/dev/null || true)
CWD=$(printf '%s' "$RAW" | /usr/bin/env node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    try { const j = JSON.parse(raw); if (typeof j.cwd === "string" && j.cwd !== "") { process.stdout.write(j.cwd); } } catch { /* malformed body: use process cwd */ }
  });
' 2>/dev/null)
cd "\${CWD:-\$PWD}" 2>/dev/null || true
exec ${cmd} hook session-start --json
`,
    },
    {
      file: 'aegisx-save-nudge.sh',
      event: 'pre_verify',
      timeout: 10,
      json: false,
      body: `#!/usr/bin/env sh
# aegisx-memory:pre-verify — when the agent edited code and is about to finish,
# nudge it once to save the handoff. Hermes accepts the Claude Stop payload
# {"decision":"block","reason":…} directly, so the reminder reaches the model
# verbatim. Exit 0 always: a hook must never fail the turn it guards.
exec 2>/dev/null
exec ${cmd} hook session-end --json
`,
    },
  ];
}

interface HermesHooksConfig {
  hooks?: Record<string, Array<{ command?: string; timeout?: number }>>;
  hooks_auto_accept?: boolean;
  [key: string]: unknown;
}

function readYamlMap(configFile: string): { doc: ReturnType<typeof parseDocument>; existed: boolean; error?: Error } {
  const existed = fs.existsSync(configFile);
  if (!existed) return { doc: parseDocument(''), existed };
  const raw = fs.readFileSync(configFile, 'utf8');
  return { doc: parseDocument(raw), existed };
}

/** Marker-based idempotence check for the hooks block. */
export function hermesHooksInstalled(configFile: string): boolean {
  if (!fs.existsSync(configFile)) return false;
  const parsed = parseDocument(fs.readFileSync(configFile, 'utf8')).toJS() as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hooks = (parsed as HermesHooksConfig).hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  for (const event of HERMES_HOOK_EVENTS) {
    const list = (hooks as HermesHooksConfig['hooks'])?.[event];
    if (!Array.isArray(list) || !list.some((h) => typeof h?.command === 'string' && h.command.includes(markerFor(event)))) return false;
  }
  return true;
}

/** The stable substring identifying our entry in a hooks list. The script
 *  *filename* is the key — the script's own comment carries the shared
 *  aegisx-memory:session-start marker, but the command line in config.yaml is
 *  a bare path, so marker-matching must key on what the path ends with. */
function markerFor(event: HermesHookEvent): string {
  return event === 'pre_llm_call' ? 'aegisx-recall.sh' : 'aegisx-save-nudge.sh';
}

/** Install (or refresh) the pair: write the scripts, merge the hooks block,
 *  back the config up before the first write. Never touches unrelated keys. */
export function installHermesHooks(configFile: string, opts: { hooksDir?: string; homeDir?: string; bin?: string } = {}): HookInstallResult {
  const scripts = hermesHookScripts(opts.bin);
  const hooksDir = opts.hooksDir ?? hermesAgentHooksDir(configFile, opts.homeDir);
  const { doc, existed } = readYamlMap(configFile);

  const root = doc.contents;
  // A fresh install (no file, or an empty one) has no root mapping yet — the
  // Document API treats both as a null node, and setIn creates the map. Only
  // a *populated* non-mapping root (a list or scalar document) is refused.
  const emptyRoot = root === null || root === undefined;
  if (!emptyRoot && !isMap(root)) {
    return { action: 'error', path: configFile, backup: null, detail: `"${configFile}" does not contain a YAML mapping — nothing was written` };
  }
  // An existing hooks block we cannot model (scalar or list) is left alone
  // rather than clobbered — same refusal contract as the MCP writer.
  const hooksItem = emptyRoot ? undefined : (root as NonNullable<typeof root>).items.find((it) => String(it.key) === 'hooks');
  if (hooksItem !== undefined && hooksItem.value !== null && !isMap(hooksItem.value)) {
    return { action: 'error', path: configFile, backup: null, detail: `"hooks" exists but is not a YAML mapping — merge manually; nothing was written` };
  }

  // Scripts: content-addressed rewrite — if the marker is present but the body
  // drifted (upgrade), the new text replaces it; that is the upgrade path.
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const s of scripts) {
    const file = path.join(hooksDir, s.file);
    fs.writeFileSync(file, s.body, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }

  const scriptPaths = Object.fromEntries(scripts.map((s) => [s.event, { command: path.join(hooksDir, s.file), timeout: s.timeout }])) as Record<HermesHookEvent, { command: string; timeout: number }>;
  const parsedRoot = doc.toJS() as unknown;
  const current = (parsedRoot !== null && typeof parsedRoot === 'object' && !Array.isArray(parsedRoot) ? (parsedRoot as HermesHooksConfig).hooks : undefined) ?? {};
  const before = JSON.stringify(current);

  const hooks: HermesHooksConfig['hooks'] = { ...current };
  for (const event of HERMES_HOOK_EVENTS) {
    const marker = markerFor(event);
    const list = (hooks[event] ?? []).filter((h) => !(typeof h?.command === 'string' && h.command.includes(marker)));
    list.push({ command: scriptPaths[event].command, timeout: scriptPaths[event].timeout });
    hooks[event] = list;
  }

  let backup: string | null = null;
  if (existed) {
    backup = `${configFile}.aegisx-bak`;
    fs.copyFileSync(configFile, backup);
  }
  doc.setIn(['hooks'], hooks);
  doc.setIn(['hooks_auto_accept'], current['hooks_auto_accept'] ?? true);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, doc.toString());

  const unchanged = JSON.stringify(hooks) === before && existed;
  return {
    action: unchanged ? 'unchanged' : existed ? 'merged' : 'created',
    path: configFile,
    backup,
    detail: unchanged ? 'hooks already installed — nothing written' : backup === null ? 'hook scripts written + hooks block created' : `previous config kept at ${backup}`,
  };
}
