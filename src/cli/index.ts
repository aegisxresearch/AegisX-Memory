#!/usr/bin/env node
/**
 * AegisX-Memory CLI.
 * Exit codes: 0 success · 1 user error · 2 internal error.
 */
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { Engine, DEFAULT_TOKEN_BUDGET, describeSessionSave } from '../core/engine.js';
import { aegisxHome, dbPath, normalizeRepoPath } from '../core/paths.js';
import { AegisxError, type KnowledgeKind, type SessionHandoffInput, type SessionSaveSummary } from '../core/types.js';
import { renderExportMarkdown, renderKnowledgeList, renderRepoSummaries } from './render.js';
import { binServerConfig, defaultServerConfig, parseAgentArg, renderConfig } from './mcp-config.js';
import { SETUP_AGENTS, describeProjectRulesResult, describeResult, describeRulesResult, installForAgent, installProjectRules, installRulesForAgent, type SetupAgent } from './auto-setup.js';
import { renderDoctorJson, renderDoctorReport, runDoctor, setEngineConstructor } from './doctor.js';
import { startDashboard } from './dashboard.js';
import { runSetupWizard } from './setup.js';
import { autoDown, autoStatus, runAuto } from './auto.js';
import { assertNotHome, describeUninstall, runUninstall, uninstallMirrorTargets } from './uninstall.js';
import {
  HOOK_INDEX_DEADLINE_MS,
  POST_EDIT_DEADLINE_MS,
  claudeSettingsPath,
  describeHookInstall,
  installClaudeHooks,
  parseHookClient,
  parseHookEvent,
  positiveIntArg,
  repoFromStdinJson,
  runHook,
} from './hooks.js';
import { configPathFor, rulesPathFor } from './auto-setup.js';
import { versionString } from './version.js';
import os from 'node:os';

const program = new Command();

function isHomeDir(dir: string): boolean {
  return path.resolve(dir) === path.resolve(os.homedir());
}

/* ------------------------------------------------------------------ version */

// Build identity lives in ./version.ts: doctor compares its own stamp against
// the build a registered MCP entry points at, so both must read one source.
program
  .name('aegisxmemory')
  .version(versionString())
  .description('Persistent memory engine for AI coding agents — stop re-reading your codebase.');

function openEngine(): Engine {
  return new Engine(dbPath());
}

// Wire the doctor's engine seam to the real implementation.
setEngineConstructor(Engine);

function run(fn: () => void | Promise<void>): void {
  void Promise.resolve()
    .then(fn)
    .catch((err: unknown) => {
      if (err instanceof AegisxError || err instanceof CommanderUserError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exitCode = 1;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
        process.exitCode = 2;
      }
    });
}

/**
 * Machine-readable output contract: every data command prints strict JSON on
 * stdout when --json is passed. Warnings/errors stay on stderr, and the exit
 * code stays authoritative (0 ok · 1 user error · 2 internal).
 */
function writeJson(payload: object, jsonMode: boolean, fallback: () => void): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    fallback();
  }
}

/** One-line preview for terminal messages (the store and --json keep it whole). */
function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Commander's own arg-parse errors map to user errors (exit 1). */
class CommanderUserError extends Error {}

function positiveInt(flag: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new CommanderUserError(`${flag} must be a positive integer`);
    }
    return parsed;
  };
}

function intArg(value: string): number {
  return positiveInt('--budget')(value);
}

/** The kinds the store accepts — kept beside the CLI so `--kind` fails loudly on
 *  a typo instead of silently listing everything. */
const KNOWLEDGE_KINDS = ['decision', 'gotcha', 'convention', 'lesson'] as const;

function knowledgeKindArg(value: string): KnowledgeKind {
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(value)) {
    throw new CommanderUserError(`--kind must be one of: ${KNOWLEDGE_KINDS.join(' | ')}`);
  }
  return value as KnowledgeKind;
}

type ExportFormat = 'md' | 'json';

function exportFormatArg(value: string): ExportFormat {
  if (value !== 'md' && value !== 'json') {
    throw new CommanderUserError('--format must be md or json');
  }
  return value;
}

// Kept as an alias so the CLI's JSON contract stays readable at the call site;
// the shape itself lives in core/types.ts with the rest of the engine's types.

function parseHandoffText(text: string): SessionHandoffInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AegisxError('user', `handoff JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  const obj = parsed as Record<string, unknown>;
  return {
    goal: requireString(obj['goal'], 'goal'),
    facts: requireStringArray(obj['facts'], 'facts'),
    decisions: requireStringArray(obj['decisions'], 'decisions'),
    // Optional: handoffs written before these lists existed must keep parsing.
    gotchas: optionalStringArray(obj['gotchas'], 'gotchas'),
    conventions: optionalStringArray(obj['conventions'], 'conventions'),
    nextSteps: requireStringArray(obj['nextSteps'], 'nextSteps'),
  };
}

function optionalStringArray(value: unknown, name: string): string[] {
  return value === undefined || value === null ? [] : requireStringArray(value, name);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AegisxError('user', `handoff.${name} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim().length > 0)) {
    throw new AegisxError('user', `handoff.${name} must be an array of non-empty strings`);
  }
  return value;
}

program
  .command('init')
  .description('create the memory home and database, print setup hints')
  .option('--json', 'machine-readable output', false)
  .action((opts: { json: boolean }) => {
    run(() => {
      const engine = openEngine();
      engine.close();
      writeJson(
        { ok: true, home: aegisxHome(), db: dbPath() },
        opts.json,
        () => {
          process.stdout.write(`AegisX-Memory ready at ${aegisxHome()}\n`);
          process.stdout.write('\nOne command does everything else (wire agents + start servers):\n');
          process.stdout.write('  aegisxmemory auto\n');
          process.stdout.write('(pick agents manually: aegisxmemory setup)\n');
        },
      );
    });
  });

program
  .command('index')
  .description('full or incremental scan of a repo (hash-based; only changed files re-extracted)')
  .option('--watch', 'keep running and rescan every 2s', false)
  .option('--json', 'machine-readable output', false)
  .argument('[path]', 'repo path', '.')
  .action((repoPath: string, opts: { watch: boolean; json: boolean }) => {
    run(async () => {
      const engine = openEngine();
      try {
        const scanOnce = (): void => {
          const stats = engine.indexRepo(repoPath, (m) => process.stderr.write(`warn: ${m}\n`));
          writeJson(
            { ok: true, ...stats },
            opts.json,
            () =>
              process.stdout.write(
                `indexed ${stats.filesTotal} files (${stats.filesChanged} changed, ` +
                  `${stats.filesDeleted} deleted, ${stats.filesSkipped} skipped) — ` +
                  `${stats.symbolsTotal} symbols in ${stats.durationMs}ms\n`,
              ),
          );
        };
        scanOnce();
        if (opts.watch) {
          process.stderr.write('watch mode: rescanning every 2s — Ctrl+C to stop\n');
          for (;;) {
            await sleep(2_000);
            scanOnce();
          }
        }
      } finally {
        engine.close();
      }
    });
  });

program
  .command('recall')
  .description('print budgeted memory context block (paste into any agent)')
  .argument('[query]', 'search query (defaults to repo-scoped recall)')
  .option('--repo <path>', 'repo root', '.')
  .option('--budget <n>', 'token budget (a target: the floor can exceed it — see the coverage line)', intArg, DEFAULT_TOKEN_BUDGET)
  .option('--full', 'return every layer whole, skipping the budget trim', false)
  .option('--json', 'machine-readable output', false)
  .action((query: string | undefined, opts: { repo: string; budget: number; full: boolean; json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        const result = engine.recall(query ?? null, opts.repo, opts.budget, { full: opts.full });
        writeJson(
          { ok: true, ...result, markdown: engine.renderMarkdown(result) },
          opts.json,
          () => process.stdout.write(engine.renderMarkdown(result) + '\n'),
        );
      } finally {
        engine.close();
      }
    });
  });

program
  .command('remember')
  .description('save a stable fact, e.g. aegisxmemory remember project.myapp.test-cmd "npm test"')
  .argument('<key>')
  .argument('<value...>')
  .option('--json', 'machine-readable output', false)
  .action((key: string, valueParts: string[], opts: { json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        const fact = engine.remember(key, valueParts.join(' '), process.cwd());
        writeJson(
          { ok: true, fact },
          opts.json,
          () => process.stdout.write(
            fact.previousValue === undefined
              ? `saved ${key}\n`
              : `saved ${key} (was: ${preview(fact.previousValue)})\n`,
          ),
        );
      } finally {
        engine.close();
      }
    });
  });

program
  .command('forget')
  .description('delete a fact by key')
  .argument('<key>')
  .option('--json', 'machine-readable output', false)
  .action((key: string, opts: { json: boolean }) => {
    run(() => {
      const engine = openEngine();
      const deleted = engine.forget(key);
      engine.close();
      if (!deleted) {
        throw new AegisxError('user', `no fact with key "${key}"`);
      }
      writeJson(
        { ok: true, key, deleted: true },
        opts.json,
        () => process.stdout.write(`deleted ${key}\n`),
      );
    });
  });

program
  .command('history')
  .description('show what a pinned fact used to be (omit <key> for recent changes across all facts)')
  .argument('[key]')
  .option('--json', 'machine-readable output', false)
  .action((key: string | undefined, opts: { json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        if (key === undefined) {
          const changes = engine.recentHistory(20);
          writeJson({ ok: true, changes }, opts.json, () => {
            if (changes.length === 0) {
              process.stdout.write('no fact has changed value yet\n');
              return;
            }
            process.stdout.write(`recent fact changes (${changes.length}):\n`);
            for (const entry of changes) {
              process.stdout.write(
                `  ${entry.key} = ${preview(entry.value)}   until ${entry.replacedAt.slice(0, 10)}\n`,
              );
            }
          });
          return;
        }
        const fact = engine.fact(key);
        const history = engine.history(key);
        if (fact === undefined && history.length === 0) {
          throw new AegisxError('user', `no fact or history for key "${key}"`);
        }
        writeJson({ ok: true, key, fact: fact ?? null, history }, opts.json, () => {
          process.stdout.write(`${key}\n`);
          if (fact !== undefined) {
            process.stdout.write(
              `  current  ${preview(fact.value)}   (since ${fact.updatedAt.slice(0, 10)})\n`,
            );
          }
          for (const entry of history) {
            process.stdout.write(
              `  was      ${preview(entry.value)}   (until ${entry.replacedAt.slice(0, 10)})\n`,
            );
          }
        });
      } finally {
        engine.close();
      }
    });
  });

program
  .command('knowledge')
  .description('list, search and filter the knowledge store (decisions, gotchas, conventions, lessons)')
  .argument('[query]', 'full-text search over entry titles and bodies')
  .option('--kind <kind>', 'only one kind: decision | gotcha | convention | lesson', knowledgeKindArg)
  .option('--repo <path>', 'only one repository (default: every repo)')
  .option('--limit <n>', 'max entries to print', positiveInt('--limit'), 50)
  .option('--repos', 'summarise every repository (knowledge / facts / handoffs) instead of listing entries', false)
  .option('--forget <id>', 'delete the entry with this id (the # shown in the listing)', positiveInt('--forget'))
  .option('--json', 'machine-readable output', false)
  .action((query: string | undefined, opts: { kind?: KnowledgeKind; repo?: string; limit: number; repos: boolean; forget?: number; json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        if (opts.forget !== undefined) {
          if (opts.repos) {
            throw new AegisxError('user', '--repos and --forget cannot be combined');
          }
          if (!engine.forgetKnowledge(opts.forget)) {
            throw new AegisxError('user', `no knowledge entry with id ${opts.forget}`);
          }
          writeJson({ ok: true, id: opts.forget, deleted: true }, opts.json, () =>
            process.stdout.write(`deleted knowledge #${opts.forget}\n`),
          );
          return;
        }
        if (opts.repos) {
          // A summary describes whole repositories, so entry filters would be
          // silently ignored — say so rather than accepting them and dropping them.
          if (query !== undefined || opts.kind !== undefined) {
            throw new AegisxError('user', '--repos summarises repositories; drop the query and --kind');
          }
          const scope = opts.repo === undefined ? undefined : normalizeRepoPath(opts.repo);
          // A guarded read first: a repo the policy hides must be refused outright,
          // not silently rendered as "no memory stored for …".
          if (scope !== undefined) {
            engine.countKnowledge({ repoAbsPath: scope });
          }
          const all = engine.repoMemorySummaries();
          const summaries = scope === undefined ? all : all.filter((entry) => entry.repo === scope);
          const totals = summaries.reduce(
            (sum, entry) => ({
              facts: sum.facts + entry.counts.facts,
              knowledge: sum.knowledge + entry.counts.knowledge,
              sessions: sum.sessions + entry.counts.sessions,
            }),
            { facts: 0, knowledge: 0, sessions: 0 },
          );
          writeJson({ ok: true, repos: summaries, totals }, opts.json, () =>
            process.stdout.write(renderRepoSummaries(summaries, scope)),
          );
          return;
        }
        const entries = engine.listKnowledge({
          ...(query === undefined ? {} : { query }),
          ...(opts.kind === undefined ? {} : { kind: opts.kind }),
          ...(opts.repo === undefined ? {} : { repoAbsPath: opts.repo }),
          limit: opts.limit,
        });
        // The true size of what was just filtered — the same number the memory
        // page prints, so neither surface can imply the store is smaller than it is.
        const total = engine.countKnowledge({
          ...(query === undefined ? {} : { query }),
          ...(opts.kind === undefined ? {} : { kind: opts.kind }),
          ...(opts.repo === undefined ? {} : { repoAbsPath: opts.repo }),
        });
        writeJson({ ok: true, knowledge: entries, shown: entries.length, total }, opts.json, () => {
          if (entries.length === 0) {
            const filtered = query !== undefined || opts.kind !== undefined || opts.repo !== undefined;
            process.stdout.write(filtered ? 'no knowledge entries match\n' : 'no knowledge entries stored yet\n');
            return;
          }
          process.stdout.write(renderKnowledgeList(entries));
          if (entries.length < total) {
            const order = query === undefined ? 'the newest' : 'the top';
            process.stdout.write(
              `(showing ${order} ${entries.length} of ${total} — raise --limit or narrow the filters)\n`,
            );
          }
        });
      } finally {
        engine.close();
      }
    });
  });

program
  .command('save')
  .description('write a session handoff from JSON (--json <file>, or pipe: aegisxmemory save --json -)')
  .option('--json [file]', 'JSON file, or - for stdin; with no value: use input mode AND JSON output')
  .action((opts: { json?: string | boolean }) => {
    run(() => {
      // Commander quirk: `--json -` yields '-', `--json` alone yields true.
      // Both mean "read handoff from stdin"; true additionally flips JSON output.
      const inputMode = typeof opts.json === 'string' ? opts.json : '-';
      const jsonOut = opts.json === true;
      const text =
        inputMode === '-'
          ? fs.readFileSync(0, 'utf8')
          : fs.readFileSync(inputMode, 'utf8');
      const handoff = parseHandoffText(text);
      const engine = openEngine();
      let summary: SessionSaveSummary;
      try {
        summary = engine.saveSession(process.cwd(), handoff);
      } finally {
        engine.close();
      }
      writeJson(
        {
          ok: true,
          saved: 'session handoff',
          repo: normalizeRepoPath(process.cwd()),
          knowledge: {
            recorded: summary.notesRecorded,
            alreadyKnown: summary.notesAlreadyKnown,
          },
        },
        jsonOut,
        () => process.stdout.write(`session handoff saved${describeSessionSave(summary)}\n`),
      );
    });
  });

program
  .command('resume')
  .description('print the last session handoff and memory for this repo')
  .option('--json', 'machine-readable output (ok:false with exit 1 when memory is empty)', false)
  .action((opts: { json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        const result = engine.recall(null, process.cwd(), DEFAULT_TOKEN_BUDGET);
        const empty =
          result.lastSession === undefined &&
          result.facts.length === 0 &&
          result.knowledge.length === 0 &&
          result.brief.includes('No indexed symbols');
        if (empty) {
          writeJson(
            { ok: false, reason: 'no memory for this repo yet', hint: 'run `aegisxmemory index .` and `aegisxmemory save` first' },
            opts.json,
            () => process.stderr.write('no memory for this repo yet — run `aegisxmemory index .` and `aegisxmemory save` first\n'),
          );
          process.exitCode = 1;
          return;
        }
        writeJson(
          { ok: true, ...result, markdown: engine.renderMarkdown(result) },
          opts.json,
          () => process.stdout.write(engine.renderMarkdown(result) + '\n'),
        );
      } finally {
        engine.close();
      }
    });
  });

program
  .command('hook')
  .description('agent lifecycle hooks: memory loads and the save reminder fire without relying on model compliance')
  .argument('<event>', 'session-start | session-end | post-edit')
  .option('--json', 'machine-readable protocol output (Claude Code SessionStart/Stop/PostToolUse JSON)', false)
  .option('--client <name>', 'hook dialect: claude (default) | hermes', 'claude')
  .option('--repo <path>', 'repo root (default: resolve from stdin JSON cwd, else process cwd)')
  .option('--budget <n>', 'session-start token budget (a target; the floor can exceed it)', intArg, DEFAULT_TOKEN_BUDGET)
  .option('--deadline <ms>', 'max time for the capped auto-index/post-edit scan (default: 10s session-start, 15s post-edit)', positiveIntArg('deadline'))
  .option('--install', 'write the SessionStart + PostToolUse hooks into Claude Code settings.json (user scope, or --project for repo scope)', false)
  .option('--project', 'with --install: target <repo>/.claude/settings.json instead of the user scope', false)
  .action((event: string, opts: { json: boolean; client: string; repo?: string; budget: number; deadline?: number; install: boolean; project: boolean }) => {
    run(async () => {
      guardHookStdout();
      const parsedEvent = parseHookEvent(event);
      if (opts.install) {
        if (parsedEvent !== 'session-start') {
          throw new AegisxError('user', '--install installs the pair (SessionStart + PostToolUse) as a set; run it without an event or with session-start');
        }
        // claudeSettingsPath(project: boolean, …): pass the flag as-is — the
        // earlier `!opts.project` here inverted scopes and wrote user files.
        const file = claudeSettingsPath(opts.project === true, opts.repo);
        const result = installClaudeHooks(file);
        process.stdout.write(describeHookInstall(result) + '\n');
        if (result.action !== 'error') {
          process.stdout.write('\nRestart Claude Code (hooks are read at launch). SessionStart loads memory automatically; every Write/Edit re-indexes.\n');
        }
        return;
      }
      // Claude Code passes the event JSON on stdin; consume it without
      // hanging when nothing is piped (raw CLI use, TTY or closed stdin).
      const raw = process.stdin.isTTY === false ? await readStdinOnce() : null;
      const repo = opts.repo ?? repoFromStdinJson(raw);
      const outcome = runHook(parsedEvent, {
        json: opts.json,
        client: parseHookClient(opts.client),
        repo,
        budget: opts.budget,
        deadlineMs: opts.deadline ?? (parsedEvent === 'post-edit' ? POST_EDIT_DEADLINE_MS : HOOK_INDEX_DEADLINE_MS),
      });
      if (outcome.stdout !== '') process.stdout.write(outcome.stdout);
      if (outcome.stderr !== '') process.stderr.write(outcome.stderr);
      process.exitCode = outcome.exitCode;
    });
  });

/** Read stdin to EOF as utf8 (Claude Code hook events arrive as one JSON
 *  document). Resolves null when stdin is a TTY; never hangs on a pipe whose
 *  writer already closed. */
function readStdinOnce(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

// Hook output is often piped (`… | head`); EPIPE arrives as an 'error' event
// on stdout, not a throw — swallow it once so a closed pipe cannot crash the
// agent that invoked the hook.
let hookStdoutGuarded = false;
function guardHookStdout(): void {
  if (hookStdoutGuarded) return;
  hookStdoutGuarded = true;
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
}

program
  .command('stats')
  .description('show memory + observability statistics for this repo')
  .option('--json', 'machine-readable output (strict JSON on stdout)', false)
  .argument('[path]', 'repo path', '.')
  .action((repoPath: string, opts: { json: boolean }) => {
    run(() => {
      const repo = normalizeRepoPath(repoPath);
      const engine = openEngine();
      try {
        const stats = engine.statsFor(repo);
        writeJson(stats as unknown as Record<string, unknown>, opts.json, () => {
          const lines: string[] = [];
          lines.push(`repo: ${stats.repo}`);
          lines.push(`files: ${stats.files}  symbols: ${stats.symbols}  facts: ${stats.facts}  knowledge: ${stats.knowledge}  sessions: ${stats.sessions}`);
          if (stats.lastScanAt !== undefined) lines.push(`last scan: ${stats.lastScanAt}`);
          lines.push('');
          lines.push('scans:');
          lines.push(`  total: ${stats.scans.total}  avg: ${stats.scans.avgDurationMs !== null ? `${stats.scans.avgDurationMs}ms` : '—'}  last: ${stats.scans.lastAt ?? '—'}`);
          if (stats.scans.recent.length > 0) {
            const r = stats.scans.recent[0] as (typeof stats.scans.recent)[number];
            lines.push(`  last run: ${r.filesTotal} files (${r.filesChanged} changed, ${r.filesDeleted} deleted) — ${r.symbolsTotal} symbols in ${r.durationMs}ms`);
          }
          lines.push('');
          lines.push('recalls:');
          lines.push(`  total: ${stats.recalls.total}  hits: ${stats.recalls.hits}  hit rate: ${stats.recalls.hitRate !== null ? `${stats.recalls.hitRate}%` : '—'}`);
          lines.push(`  avg tokens/recall: ${stats.recalls.avgTokens ?? '—'}  tokens saved (est.): ${stats.recalls.tokensSavedEstimate ?? '—'}`);
          // Convenience rollup line for dashboards/badges
          lines.push('');
          lines.push(`tokens saved (est.): ${stats.tokensSavedEstimate ?? '—'}  ·  hit rate: ${stats.hitRate !== null ? `${stats.hitRate}%` : '—'}`);
          process.stdout.write(lines.join('\n') + '\n');
        });
      } finally {
        engine.close();
      }
    });
  });

program
  .command('export')
  .description('dump facts, knowledge and handoffs as markdown (default) or JSON — backup, portability, review')
  .option('--format <fmt>', 'md | json', exportFormatArg, 'md')
  .option('--repo <path>', 'limit the dump to one repository (default: everything)')
  .option('--json', 'shorthand for --format json', false)
  .action((opts: { format: ExportFormat; repo?: string; json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        const data = engine.exportMemory(opts.repo);
        const home = aegisxHome();
        writeJson({ ok: true, home, ...data }, opts.json || opts.format === 'json', () =>
          process.stdout.write(renderExportMarkdown(data, home)),
        );
      } finally {
        engine.close();
      }
    });
  });

program
  .command('watch')
  .description('keep the index fresh: incremental re-index on every file change (event-driven)')
  .argument('[path]', 'repo path', '.')
  .option('--debounce <ms>', 'debounce window in ms', intArg, 300)
  .option('--poll', 'use polling instead of native FS events (for network/VM filesystems)', false)
  .option('--interval <ms>', 'polling interval in ms (only with --poll)', intArg, 2000)
  .option('--json', 'machine-readable per-scan JSON lines on stdout', false)
  .action((repoPath: string, opts: { debounce: number; poll: boolean; interval: number; json: boolean }) => {
    run(async () => {
      const { startWatch } = await import('./watch.js');
      const handle = await startWatch({
        repoPath,
        dbFile: dbPath(),
        debounceMs: opts.debounce,
        usePolling: opts.poll,
        pollIntervalMs: opts.interval,
        onScan: (stats) => {
          writeJson({ ok: true, event: 'scan', ...stats }, opts.json, () =>
            process.stdout.write(
              `watch: indexed ${stats.filesTotal} files (${stats.filesChanged} changed, ${stats.filesDeleted} deleted, ${stats.filesSkipped} skipped) — ${stats.symbolsTotal} symbols in ${stats.durationMs}ms\n`,
            ),
          );
        },
        onWarn: (m) => process.stderr.write(`warn: ${m}\n`),
        onError: (e) => process.stderr.write(`watch error: ${e.message}\n`),
      });
      const mode = opts.poll ? `polling every ${opts.interval}ms` : 'event-driven';
      process.stderr.write(`watching ${path.resolve(repoPath)} — ${mode}, debounce ${opts.debounce}ms — Ctrl+C to stop\n`);
      const shutdown = (): void => {
        void handle.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // Keep the process alive — chokidar's watcher holds the event loop.
      await new Promise<void>(() => undefined);
    });
  });

program
  .command('auto')
  .description('everything after install: auto-wire detected agents, start the MCP HTTP server + dashboard as daemons, print the live URLs')
  .option('--mcp-port <n>', 'preferred TCP port for the MCP HTTP server (auto-increments when taken)', intArg, 3359)
  .option('--dash-port <n>', 'preferred TCP port for the dashboard (auto-increments when taken)', intArg, 3360)
  .option('--no-setup', 'skip agent wiring (for dotfiles/CI that manage agent configs themselves)')
  .option('--status', 'print whether the auto daemons are running, without changing anything', false)
  .option('--down', 'stop the auto-started daemons (agent wiring is kept)', false)
  .action((opts: { mcpPort: number; dashPort: number; setup: boolean; status: boolean; down: boolean }) => {
    run(async () => {
      if (opts.status) {
        process.stdout.write(autoStatus().detail + '\n');
        return;
      }
      if (opts.down) {
        const d = autoDown();
        process.stdout.write(`${d.detail}\n`);
        return;
      }
      if (opts.setup && isHomeDir(process.cwd())) {
        process.stdout.write('(home directory — the repo-level AGENTS.md and project hooks are skipped)\n');
      }
      const report = await runAuto({
        mcpPort: opts.mcpPort,
        dashPort: opts.dashPort,
        setup: opts.setup,
        projectDir: process.cwd(),
      });
      process.stdout.write('');
      if (report.agents.length > 0) {
        process.stdout.write(`\nAgents wired: ${report.agents.join(', ')}\n`);
        process.stdout.write('Restart those agents (MCP has no hot reload) — memory then loads and saves itself.\n');
      }
      if (report.mcpHttp !== null) {
        process.stdout.write(`\nMCP HTTP server: ${report.mcpHttp.url}\n`);
        process.stdout.write('  (agents that speak streamable HTTP can point here; localhost-only)\n');
      }
      if (report.dashboard !== null) {
        process.stdout.write(`Dashboard:        ${report.dashboard.url}\n`);
      }
      for (const note of report.notes) process.stdout.write(`note: ${note}\n`);
      process.stdout.write('\nStop later with: aegisxmemory auto --down  ·  check with: aegisxmemory auto --status\n');
    });
  });

program
  .command('mcp')
  .description('run the MCP stdio server exposing memory tools to AI agents')
  .action(() => {
    run(async () => {
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer();
    });
  });

program
  .command('doctor')
  .description('health check: DB integrity, schema, index freshness, MCP registrations')
  .argument('[path]', 'repo path for freshness check (optional)', '.')
  .option('--no-repo', 'skip the repo freshness check')
  .option('--fix', 'auto-fix safe issues (init DB, re-index); never touches MCP configs or corrupt DBs', false)
  .option('--json', 'machine-readable output (strict JSON on stdout; exit 1 = checks failed)', false)
  .action((repoPath: string, opts: { repo: boolean; fix: boolean; json: boolean }) => {
    run(() => {
      const report = runDoctor(dbPath(), opts.repo ? repoPath : null, {
        fix: opts.fix,
        onWarn: (m) => process.stderr.write(`warn: ${m}\n`),
      });
      if (opts.json) {
        process.stdout.write(renderDoctorJson(report, aegisxHome(), opts.repo ? repoPath : null) + '\n');
      } else {
        process.stdout.write(renderDoctorReport(report, aegisxHome()) + '\n');
      }
      if (!report.passed) {
        process.exitCode = 1;
      }
    });
  });

program
  .command('serve')
  .description('run the MCP server over HTTP (localhost-only; for remote/IDE agents)')
  .option('--port <n>', 'TCP port', intArg, 3359)
  .option('--host <h>', 'bind address — keep 127.0.0.1 unless you know what you are doing', '127.0.0.1')
  .option('--token <t>', 'require a bearer token (recommended; env AEGISX_TOKEN also works)')
  .action((opts: { port: number; host: string; token?: string }) => {
    run(async () => {
      const { runServe } = await import('../mcp/http-server.js');
      // Empty-string credentials are no credentials: '' from --token or the
      // environment must not slip past the non-localhost guard as a real token.
      const envToken = process.env['AEGISX_TOKEN'];
      const token = opts.token ?? (envToken !== undefined && envToken.trim() !== '' ? envToken : null);
      if (opts.host !== '127.0.0.1' && token === null) {
        process.stderr.write('refusing to serve non-localhost without --token (security guard)\n');
        process.exitCode = 1;
        return;
      }
      await runServe({ port: opts.port, host: opts.host, token });
    });
  });

program
  .command('dashboard')
  .description('open a local web dashboard of the memory (read-only, localhost-only)')
  .option('--port <n>', 'TCP port', intArg, 3360)
  .option('--no-open', "don't launch the browser automatically")
  .action((opts: { port: number; open: boolean }) => {
    run(async () => {
      const { url, stop } = await startDashboard(
        { port: opts.port, host: '127.0.0.1', open: opts.open },
        openEngine(),
      );
      process.stdout.write(`Dashboard: ${url}  (Ctrl+C to stop)\n`);
      const shutdown = (): void => {
        void stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  });

program
  .command('setup')
  .description('interactive onboarding: connect your agent + enable auto-memory in one guided flow (recommended for first-time users)')
  .option('--yes', 'non-interactive: apply the answers below without asking (for scripts and dotfiles)', false)
  .option('--agent <name>', 'with --yes: comma-separated agents to wire (hermes, claude, cursor, gemini, codex, windsurf, vscode, all)', 'hermes')
  .option('--no-rules', 'with --yes: skip the auto-memory behavior rules')
  .action((opts: { yes: boolean; agent: string; rules: boolean }) => {
    run(async () => {
      const engine = openEngine();
      try {
        if (opts.yes) {
          const names = opts.agent.split(',').map((s) => s.trim()).filter((s) => s !== '');
          const agents: SetupAgent[] = [];
          for (const name of names) {
            if (name === 'all') agents.push(...SETUP_AGENTS);
            else if ((SETUP_AGENTS as readonly string[]).includes(name)) agents.push(name as SetupAgent);
            else throw new AegisxError('user', `unknown agent "${name}"; expected one of: ${SETUP_AGENTS.join(', ')}, all`);
          }
          if (agents.length === 0) agents.push('hermes');
          // An explicit --yes is an answer, not an absence of one: the wizard
          // must not ask anything, and the TTY check is irrelevant here.
          await runSetupWizard(engine, {
            projectDir: process.cwd(),
            yes: { agents, rules: opts.rules },
          });
          return;
        }
        // The wizard also plants the contract in this repo's AGENTS.md, so agents
        // it has no writer for still get automatic memory.
        await runSetupWizard(engine, { projectDir: process.cwd() });
      } finally {
        engine.close();
      }
    });
  });

program
  .command('uninstall')
  .description('remove the aegisx-memory wiring (MCP registrations, rules, hooks) — your memory data in ~/.aegisx is never touched')
  .option('--agent <name>', 'comma-separated agents to unwire (hermes, claude, cursor, gemini, codex, windsurf, vscode, all)', 'all')
  .option('--project', 'also strip the managed block from <repo>/AGENTS.md', false)
  .option('--hooks', 'also remove the Claude Code hook pair', false)
  .option('--dry-run', 'print what would be removed without changing anything', false)
  .action((opts: { agent: string; project: boolean; hooks: boolean; dryRun: boolean }) => {
    run(() => {
      const names = opts.agent.split(',').map((s) => s.trim()).filter((s) => s !== '');
      const agents: SetupAgent[] = [];
      for (const name of names) {
        if (name === 'all') agents.push(...SETUP_AGENTS);
        else if ((SETUP_AGENTS as readonly string[]).includes(name)) agents.push(name as SetupAgent);
        else throw new AegisxError('user', `unknown agent "${name}"; expected one of: ${SETUP_AGENTS.join(', ')}, all`);
      }
      if (opts.project) assertNotHome(process.cwd());
      const scope = { agents, hooks: opts.hooks, project: opts.project, projectDir: process.cwd() };
      if (opts.dryRun) {
        // Print from the same predicate a real run uses, so the preview shows
        // the mirrored repo AGENTS.md / project hooks too — not just the
        // per-agent files.
        const mirror = uninstallMirrorTargets(agents);
        const inRepo = path.resolve(process.cwd()) !== path.resolve(os.homedir());
        process.stdout.write('dry-run — nothing was removed. Would touch:\n');
        for (const agent of agents) {
          process.stdout.write(`  mcp: ${configPathFor(agent)}\n`);
          const rules = rulesPathFor(agent);
          if (rules !== null) process.stdout.write(`  rules: ${rules}\n`);
        }
        if (opts.hooks) process.stdout.write(`  hooks: ${claudeSettingsPath(false)}\n`);
        if (inRepo && (opts.project || mirror.project)) process.stdout.write(`  project: ${path.join(process.cwd(), 'AGENTS.md')}\n`);
        if (opts.hooks || (inRepo && mirror.hooks)) process.stdout.write(`  hooks (project): ${claudeSettingsPath(true, process.cwd())}\n`);
        if (!inRepo && (mirror.project || mirror.hooks)) process.stdout.write('  (home directory — the repo-level files are skipped)\n');
        return;
      }
      for (const r of runUninstall(scope)) {
        process.stdout.write(describeUninstall(r) + '\n');
      }
      process.stdout.write('\nRestart the affected agents. Memory data (facts, knowledge, handoffs) in ~/.aegisx was NOT touched —\ndelete it manually with `rm -rf ~/.aegisx` if that is what you want.\n');
    });
  });

program
  .command('mcp-config')
  .description('print ready-to-paste MCP registration blocks (hermes | claude | cursor | all)')
  .option('--agent <name>', 'target agent: hermes, claude, cursor, or all', 'all')
  .option('--bin', 'assume `aegisxmemory` is on PATH (npm link) instead of an absolute node entry', false)
  .option('--install', 'write the registration straight into the agent config(s) — backed up, idempotent, no hand-editing', false)
  .option('--rules', 'also install auto-memory behavior rules (auto recall at session start, auto save at end) into the agent\'s standing instructions', false)
  .option('--project-rules [dir]', 'also write the memory rules into <dir>/AGENTS.md (default: this directory) — the one file most agents read with no per-client setup', false)
  .action((opts: { agent: string; bin: boolean; install: boolean; rules: boolean; projectRules?: string | boolean }) => {
    run(() => {
      const agent = parseAgentArg(opts.agent);
      const cfg = opts.bin ? binServerConfig() : defaultServerConfig();
      const wantsProjectRules = opts.projectRules !== undefined && opts.projectRules !== false;
      // Project rules are agent-agnostic (one shared AGENTS.md), so they are
      // written on their own request and never inherit --agent.
      if (wantsProjectRules) {
        const dir = typeof opts.projectRules === 'string' ? opts.projectRules : process.cwd();
        process.stdout.write(describeProjectRulesResult(installProjectRules(dir)) + '\n');
      }
      if (opts.install) {
        const targets = agent === 'all' ? SETUP_AGENTS : [agent as SetupAgent];
        for (const target of targets) {
          process.stdout.write(describeResult(installForAgent(target, { config: cfg })) + '\n');
        }
        if (opts.rules) {
          for (const target of targets) {
            process.stdout.write(describeRulesResult(installRulesForAgent(target, {})) + '\n');
          }
        }
        process.stdout.write('\nDone. Restart your agent (MCP has no hot reload) — the memory tools load automatically.\n');
        return;
      }
      // Nothing was asked to be written, so the paste block is the answer. With
      // --project-rules alone the file *was* the deliverable — stay quiet.
      if (wantsProjectRules) return;
      process.stdout.write(renderConfig(agent, cfg) + '\n');
    });
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Argument parsing sits outside `run()` on purpose: a custom option parser
 * (`--limit`, `--kind`, `--budget`, …) throws synchronously out of commander,
 * so without this the process died with a raw stack trace and `Node.js v22…`
 * instead of the `error:` line and exit code this CLI documents.
 */
function handleParseFailure(err: unknown): void {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = err instanceof CommanderUserError ? 1 : 2;
}

try {
  void program.parseAsync(process.argv).catch(handleParseFailure);
} catch (err) {
  handleParseFailure(err);
}
