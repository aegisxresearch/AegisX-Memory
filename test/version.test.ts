/**
 * `--version` must carry the real build identity (commit + date), because the
 * package.json semver alone read `1.0.0` through dozens of behavioral changes
 * and once made a fresh-install user ask why nothing had moved. Outside a git
 * checkout (npm tarball, bare dist copy) it degrades to the base string
 * instead of failing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION_BASE } from '../src/core/version.js';

const DIST_ENTRY = path.resolve('dist/cli/index.js');
const built = fs.existsSync(DIST_ENTRY);
const suite = built ? describe : describe.skip;

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-version-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function runVersion(cwd: string): string {
  return execFileSync(process.execPath, [DIST_ENTRY, '--version'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

suite('cli --version', () => {
  it('the released version is declared once and agrees with package.json', () => {
    // A release bump that lands in one file only is how `1.0.0` survived dozens
    // of behavioral changes: the MCP handshake, `--version` and package.json all
    // quote the same number, so drift has to fail here rather than ship.
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(VERSION_BASE);
  });

  it('happy: prints semver + short commit + commit date', () => {
    const out = runVersion(process.cwd());
    const escaped = VERSION_BASE.replace(/\./g, '\\.');
    expect(out).toMatch(new RegExp(`^${escaped} \\([0-9a-f]{7,40} · \\d{4}-\\d{2}-\\d{2}\\)$`));
    // The commit must be *this checkout's* HEAD, not a stale constant.
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(out).toContain(`(${head} ·`);
  });

  it('negative: a dist copy outside the checkout falls back to the bare semver, never a crash', () => {
    // The fallback triggers on the module's own location, not the cwd: a real
    // npm install has no `.git` next to `dist/`. Copy the build to a plain
    // directory (with the runtime deps it needs) and run it there.
    const copy = path.join(workspace, 'pkg');
    fs.mkdirSync(path.join(copy, 'node_modules'), { recursive: true });
    fs.cpSync(path.resolve('dist'), path.join(copy, 'dist'), { recursive: true });
    for (const dep of fs.readdirSync(path.join(process.cwd(), 'node_modules'))) {
      if (dep.startsWith('.') || dep.startsWith('@types')) continue;
      fs.cpSync(path.join(process.cwd(), 'node_modules', dep), path.join(copy, 'node_modules', dep), { recursive: true });
    }
    const out = execFileSync(process.execPath, [path.join(copy, 'dist', 'cli', 'index.js'), '--version'], {
      cwd: copy,
      encoding: 'utf8',
    }).trim();
    expect(out).toBe(VERSION_BASE);
  });
});
