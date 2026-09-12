#!/usr/bin/env node
/**
 * AegisX-Memory CLI.
 * Exit codes: 0 success · 1 user error · 2 internal error.
 */
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { Engine, DEFAULT_TOKEN_BUDGET } from '../core/engine.js';
import { aegisxHome, dbPath, normalizeRepoPath } from '../core/paths.js';
import { AegisxError } from '../core/types.js';
import { binServerConfig, defaultServerConfig, parseAgentArg, renderConfig } from './mcp-config.js';
import { SETUP_AGENTS, describeResult, describeRulesResult, installForAgent, installRulesForAgent, type SetupAgent } from './auto-setup.js';
import { renderDoctorJson, renderDoctorReport, runDoctor, setEngineConstructor } from './doctor.js';
import { startDashboard } from './dashboard.js';
import { runSetupWizard } from './setup.js';

const program = new Command();

program
  .name('aegisxmemory')
  .version('1.0.0')
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

function intArg(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new CommanderUserError('--budget must be a positive integer');
  }
  return parsed;
}

interface HandoffInput {
  goal: string;
  facts: string[];
  decisions: string[];
  nextSteps: string[];
}

function parseHandoffText(text: string): HandoffInput {
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
    nextSteps: requireStringArray(obj['nextSteps'], 'nextSteps'),
  };
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
          process.stdout.write('\nConnecting your agent (Hermes/Claude/Cursor)? One command does it all:\n');
          process.stdout.write('  aegisxmemory setup\n');
          process.stdout.write('(or manually: aegisxmemory mcp-config --install --agent hermes --rules)\n');
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
  .option('--budget <n>', 'token budget', intArg, DEFAULT_TOKEN_BUDGET)
  .option('--json', 'machine-readable output', false)
  .action((query: string | undefined, opts: { repo: string; budget: number; json: boolean }) => {
    run(() => {
      const engine = openEngine();
      try {
        const result = engine.recall(query ?? null, opts.repo, opts.budget);
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
      try {
        engine.saveSession(process.cwd(), handoff);
      } finally {
        engine.close();
      }
      writeJson(
        { ok: true, saved: 'session handoff', repo: normalizeRepoPath(process.cwd()) },
        jsonOut,
        () => process.stdout.write('session handoff saved\n'),
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
  .action(() => {
    run(async () => {
      const engine = openEngine();
      try {
        await runSetupWizard(engine);
      } finally {
        engine.close();
      }
    });
  });

program
  .command('mcp-config')
  .description('print ready-to-paste MCP registration blocks (hermes | claude | cursor | all)')
  .option('--agent <name>', 'target agent: hermes, claude, cursor, or all', 'all')
  .option('--bin', 'assume `aegisxmemory` is on PATH (npm link) instead of an absolute node entry', false)
  .option('--install', 'write the registration straight into the agent config(s) — backed up, idempotent, no hand-editing', false)
  .option('--rules', 'also install auto-memory behavior rules (auto recall at session start, auto save at end) into the agent\'s standing instructions', false)
  .action((opts: { agent: string; bin: boolean; install: boolean; rules: boolean }) => {
    run(() => {
      const agent = parseAgentArg(opts.agent);
      const cfg = opts.bin ? binServerConfig() : defaultServerConfig();
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
      process.stdout.write(renderConfig(agent, cfg) + '\n');
    });
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void program.parseAsync(process.argv);
