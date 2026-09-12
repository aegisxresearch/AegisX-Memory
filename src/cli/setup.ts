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
import { SETUP_AGENTS, configPathFor, describeProjectRulesResult, describeResult, describeRulesResult, detectInstalledAgents, installForAgent, installProjectRules, installRulesForAgent, type SetupAgent } from './auto-setup.js';
import { claudeSettingsPath, describeHookInstall, installClaudeHooks } from './hooks.js';
import { installHermesHooks } from './hermes-hooks.js';import { defaultServerConfig } from './mcp-config.js';
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
  /**
   * Injectable detection seam (tests): overrides the on-disk probe so a test
   * can simulate an installed agent without creating real home files.
   */
  detected?: SetupAgent[];
  /**
   * Non-interactive mode (`setup --yes`): skip every question and apply the
   * given choices. Agents default to hermes when omitted; rules default to
   * on. Distinct from the non-TTY fallback — this is an *explicit* answer,
   * so it works in scripts and dotfiles setups where stdin is a real TTY but
   * asking would still be wrong.
   */
  yes?: { agents?: SetupAgent[]; rules?: boolean };
  /**
   * Injectable prompt seam (tests): when set, the wizard takes its choice
   * from here instead of asking readline — the interactive path stays
   * untouched for real users, and fakes need no timing games with streams.
   */
  prompt?: () => Promise<SetupChoice> | SetupChoice;
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

function printMenu(detected: readonly string[]): void {
  say('\nSetup AegisX-Memory — memori permanen untuk AI agent Anda.\n');
  if (detected.length > 0) {
    say(`Terpasang di mesin ini: ${detected.join(', ')}.\n`);
  } else {
    say('Tidak ada config agent yang terdeteksi — Hermes dipakai sebagai default.\n');
  }
  say('\nAgent mana yang Anda pakai?\n');
  for (const a of AGENT_LABELS) {
    const tag = detected.includes(a.agent) ? '  ← terdeteksi' : '';
    say(`  ${a.key}. ${a.hint}${tag}\n`);
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
  const instream = input;
  // One detection pass for every mode: `--yes` without explicit agents, the
  // interactive default, and the non-TTY fallback all prefer what is actually
  // installed over a hardcoded guess.
  const detected = options.detected ?? detectInstalledAgents(options.projectDir).filter((p) => p.installed).map((p) => p.agent);
  let choice: SetupChoice;

  if (options.yes !== undefined) {
    // Explicit non-interactive mode: the answers were given on the command
    // line, so none are asked — not even the TTY check matters.
    choice = { agents: options.yes.agents ?? (detected.length > 0 ? detected : ['hermes']), rules: options.yes.rules ?? true };
    say(`(mode non-interaktif --yes: ${choice.agents.join(', ')} + aturan ${choice.rules ? 'aktif' : 'mati'})\n`);
  } else if (options.prompt !== undefined) {
    // Test/programmatic seam: no readline, no stream timing.
    choice = await options.prompt();
    say('');
  } else if (instream.isTTY === true) {
    const defaultAgents: SetupAgent[] = detected.length > 0 ? detected : ['hermes'];
    const rl = readline.createInterface({ input: instream, output });
    try {
      printMenu(detected);
      const agentAnswer = await askUntil(rl, `Pilih 1-8 [Enter = ${defaultAgents.join('+')}]: `, resolveAgents);
      const agents = resolveAgents(agentAnswer) ?? defaultAgents;
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
  } else {
    // Non-TTY: never hang. Auto-detect replaces the hardcoded hermes default:
    // the agent the user actually has beats a guess about the one they might.
    const agents: SetupAgent[] = detected.length > 0 ? detected : ['hermes'];
    choice = { agents, rules: true };
    say(`(bukan sesi interaktif — memakai deteksi otomatis: ${agents.join(', ')} + aturan otomatis)\n`);
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

  // Claude Code hooks are the one automation layer that does not depend on
  // the model reading any rules file: the agent itself fires them. Installed
  // automatically whenever Claude is among the chosen targets and rules are
  // on; project scope only — a wizard never edits the user's global settings.
  if (choice.rules && choice.agents.includes('claude') && options.projectDir !== undefined && path.resolve(options.projectDir) !== path.resolve(os.homedir())) {
    say(describeHookInstall(installClaudeHooks(claudeSettingsPath(true, options.projectDir))) + '\n');
    say('   (SessionStart memuat ingatan otomatis; tiap Write/Edit di-indeks ulang — tanpa bergantung kepatuhan model.)\n');
  }

  // Hermes gets the equivalent deterministic layer as shell hooks declared in
  // config.yaml: pre_llm_call injects the recall block, pre_verify nudges the
  // save. Same automation guarantee, same marker-based idempotence, and the
  // user-level config is the right scope — hooks resolve the repo from the
  // event payload at runtime, so one install covers every project.
  if (choice.rules && choice.agents.includes('hermes')) {
    const cfgPath = configPathFor('hermes');
    say(describeHookInstall(installHermesHooks(cfgPath)) + '\n');
    say('   (pre_llm_call menyuntik ingatan tiap sesi; pre_verify mengingatkan save — otomatis, bukan minta patuh.)\n');
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
