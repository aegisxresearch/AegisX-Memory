/**
 * `aegisxmemory setup` — the one-command onboarding wizard for non-technical
 * users. Asks in plain language, then does everything:
 *   1. which agent do you use?        (Hermes / Claude / Cursor / all)
 *   2. should it remember on its own? (writes the auto-memory rules)
 *   3. done — restart your agent; here is what happens next.
 *
 * Design rules:
 *  - never the only path: every action is still available as flags on
 *    `mcp-config --install` (setup simply chains them);
 *  - non-interactive-safe: when stdin is not a TTY (CI, piped), it skips the
 *    questions and applies sensible defaults (hermes + rules) instead of hanging;
 *  - idempotent: safe to run again any time — it reports what is already done.
 */
import readline from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { SETUP_AGENTS, describeProjectRulesResult, describeResult, describeRulesResult, installForAgent, installProjectRules, installRulesForAgent, type SetupAgent } from './auto-setup.js';
import { defaultServerConfig } from './mcp-config.js';
import type { Engine } from '../core/engine.js';

export interface SetupChoice {
  agents: SetupAgent[];
  rules: boolean;
}

export interface SetupOptions {
  /**
   * When set (and rules are on), the same contract is also written into this
   * project's `AGENTS.md` — the file Codex, Cursor, Copilot, Gemini CLI and
   * friends read without any per-client setup, so memory stays automatic for
   * agents this wizard has no writer for. Left undefined by programmatic
   * callers so a test can never modify a real repository.
   */
  projectDir?: string;
}

const AGENT_LABELS: ReadonlyArray<{ key: string; agent: SetupAgent | 'all'; hint: string }> = [
  { key: '1', agent: 'hermes', hint: 'Hermes Agent' },
  { key: '2', agent: 'claude', hint: 'Claude (Desktop / Code)' },
  { key: '3', agent: 'cursor', hint: 'Cursor' },
  { key: '4', agent: 'gemini', hint: 'Gemini CLI' },
  { key: '5', agent: 'codex', hint: 'Codex CLI (OpenAI)' },
  { key: '6', agent: 'windsurf', hint: 'Windsurf' },
  { key: '7', agent: 'vscode', hint: 'VS Code / Copilot (repo ini)' },
  { key: '8', agent: 'all', hint: 'Semua / All of the above' },
];

function resolveAgents(answer: string): SetupAgent[] | null {
  const cleaned = answer.trim().toLowerCase();
  if (cleaned === '') return null; // empty = default
  const byKey = AGENT_LABELS.find((a) => a.key === cleaned);
  if (byKey) return byKey.agent === 'all' ? [...SETUP_AGENTS] : [byKey.agent];
  const byName = SETUP_AGENTS.find((a) => a === cleaned);
  if (byName) return [byName];
  if (cleaned === 'all' || cleaned === 'semua') return [...SETUP_AGENTS];
  return null; // unrecognized
}

function resolveYes(answer: string): boolean | null {
  const cleaned = answer.trim().toLowerCase();
  if (cleaned === '') return true; // empty = yes (recommended default)
  if (['y', 'yes', 'ya', 'yoi', 'ok', 'oke', '1'].includes(cleaned)) return true;
  if (['n', 'no', 'tidak', 'ga', 'gak', '0'].includes(cleaned)) return false;
  return null;
}

/** Write that survives a closed pipe (`setup | head`): EPIPE on stdout arrives
 *  as an 'error' *event*, not a throw — swallow it once here so a consumer
 *  closing the pipe early can never crash the wizard. */
let stdoutGuarded = false;
function guardStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return; // consumer closed the pipe — fine
    throw err;
  });
}

function say(text: string): void {
  guardStdout();
  process.stdout.write(text);
}

function printMenu(): void {
  say('\nSetup AegisX-Memory — memori permanen untuk AI agent Anda.\n');
  say('\nAgent mana yang Anda pakai?\n');
  for (const a of AGENT_LABELS) {
    say(`  ${a.key}. ${a.hint}\n`);
  }
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return rl.question(question);
}

async function askUntil(rl: readline.Interface, question: string, resolve: (a: string) => unknown): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = await ask(rl, question);
    if (resolve(answer) !== null) return answer;
    say('  → jawaban tidak dikenali, coba lagi (atau Enter untuk default).\n');
  }
  return ''; // fall back to defaults after 5 tries
}

/** Run the wizard. `engine` is optional (used to show a final verification line). */
export async function runSetupWizard(engine?: Engine, options: SetupOptions = {}): Promise<void> {
  const interactive = input.isTTY === true;
  let choice: SetupChoice;

  if (!interactive) {
    // Non-TTY: never hang. Apply the recommended defaults.
    choice = { agents: ['hermes'], rules: true };
    say('(bukan sesi interaktif — memakai default: hermes + aturan otomatis)\n');
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      printMenu();
      const agentAnswer = await askUntil(rl, 'Pilih 1-8 [Enter = 1, Hermes]: ', resolveAgents);
      const agents = resolveAgents(agentAnswer) ?? ['hermes'];
      const rulesAnswer = await askUntil(
        rl,
        'Aktifkan ingatan otomatis (recall saat mulai, save saat selesai)? [Y/n]: ',
        resolveYes,
      );
      const rules = resolveYes(rulesAnswer) ?? true;
      choice = { agents, rules };
      say('');
    } finally {
      rl.close();
    }
  }

  say('\n');
  const cfg = defaultServerConfig();
  for (const agent of choice.agents) {
    say(describeResult(installForAgent(agent, { config: cfg })) + '\n');
    if (choice.rules) {
      say(describeRulesResult(installRulesForAgent(agent, {})) + '\n');
    }
  }

  // The repo-level file is the fallback that reaches agents this wizard has no
  // writer for. A home directory is the one place it would be noise, so the
  // write is skipped there rather than scattering rules into `$HOME`.
  const projectDir = options.projectDir;
  if (choice.rules && projectDir !== undefined && path.resolve(projectDir) !== path.resolve(os.homedir())) {
    say(describeProjectRulesResult(installProjectRules(projectDir)) + '\n');
    say('   (AGENTS.md ikut dibaca agent lain \u2014 Codex, Copilot, Gemini CLI, Zed \u2014 tanpa setup tambahan.)\n');
  }

  const names = choice.agents.join(', ');
  say(`\nSelesai untuk: ${names}.\n`);
  say('Langkah terakhir: TUTUP lalu BUKA lagi agent Anda (MCP tidak bisa hot-reload).\n');
  say('\nSetelah itu, cukup bicara normal. Contoh di Hermes:\n');
  say('  - "recall the project memory"  → dia baca ingatannya\n');
  say('  - "save the session handoff"   → dia catat progres (otomatis jika rules aktif)\n');
  say('  - "remember that tests run with npm test" → dia pin fakta\n');
  if (engine) {
    try {
      const data = engine.dashboardData();
      say(`\nStatus memori saat ini: ${data.totals.facts} fakta · ${data.totals.sessions} handoff.\n`);
      say('Intip semuanya kapan saja: aegisxmemory dashboard\n');
    } catch {
      // verification is best-effort; never fail setup on it
    }
  }
  say('\nButuh bantuan? Jalankan: aegisxmemory doctor\n');
}
