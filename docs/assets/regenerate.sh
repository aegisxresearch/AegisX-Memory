#!/usr/bin/env bash
# Regenerate docs/assets/setup.gif — a genuine run of `aegisxmemory setup`,
# recorded on a PTY and rendered to a GIF.
#
# Why not vhs? vhs drives the terminal through a headless browser; in minimal
# containers that browser usually cannot start (no SUID sandbox) and vhs then
# exits 0 while writing nothing. This pipeline uses only util-linux `script`
# (PTY + timing log) and asciinema `agg` (recording -> GIF), so it works
# headless.
#
# Requirements: bash, util-linux `script`, node, agg
#               (static binary: https://github.com/asciinema/agg/releases)
#
# Usage:
#   npm run build
#   bash docs/assets/regenerate.sh [output.gif]
#
# DEMO_HOME selects the throwaway home directory the recording happens in. It
# defaults to /tmp so a casual re-run cannot touch real user data; the committed
# GIF was recorded with DEMO_HOME=/home/firman so the paths on screen match a
# real user's machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_HOME="${DEMO_HOME:-/tmp/aegisx-demo-home}"
DEMO_PROJECT="$DEMO_HOME/koniciwa"
OUT="${1:-$REPO_ROOT/docs/assets/setup.gif}"
COLS=110
ROWS=34
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -d "$REPO_ROOT/dist" ] || { echo "dist/ missing — run: (cd $REPO_ROOT && npm run build)" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
command -v agg  >/dev/null || { echo "agg not found — install from https://github.com/asciinema/agg" >&2; exit 1; }

# Recording overwrites agent config in DEMO_HOME, so refuse anything that is not
# clearly a throwaway directory — never the real home, never the filesystem root.
case "$DEMO_HOME" in
  /|""|/root|"$HOME") echo "refusing to record in $DEMO_HOME — set DEMO_HOME to a throwaway directory" >&2; exit 1 ;;
esac

# 1. Mirror the production install layout inside the demo home, so the recorded
#    output is byte-for-byte what a real install prints. Only the paths this
#    script owns are removed.
rm -rf "$DEMO_HOME/.hermes" "$DEMO_HOME/.aegisx-app" "$DEMO_HOME/.aegisx" "$DEMO_PROJECT"
rm -f "$DEMO_HOME/.local/bin/aegisxmemory"
mkdir -p "$DEMO_HOME/.hermes" "$DEMO_HOME/.aegisx-app" "$DEMO_HOME/.local/bin" "$DEMO_PROJECT"
cp -r "$REPO_ROOT/dist" "$DEMO_HOME/.aegisx-app/dist"
cp "$REPO_ROOT/package.json" "$DEMO_HOME/.aegisx-app/"
ln -sfn "$REPO_ROOT/node_modules" "$DEMO_HOME/.aegisx-app/node_modules"
printf '#!/bin/sh\nexec node %s "$@"\n' "$DEMO_HOME/.aegisx-app/dist/cli/index.js" \
  > "$DEMO_HOME/.local/bin/aegisxmemory"
chmod +x "$DEMO_HOME/.local/bin/aegisxmemory"

# 2. The session itself. Prompts are echoed by hand; every byte of command
#    output below is produced by the real CLI, and the two wizard answers arrive
#    as real keystrokes on the PTY.
cat > "$WORK/record.sh" <<SESSION
#!/bin/bash
set -u
export TERM=xterm-256color
export HOME="$DEMO_HOME"
export PATH="$DEMO_HOME/.local/bin:\$PATH"
unset AEGISX_HOME
# Pin the PTY size so the recording is identical on every machine.
stty cols $COLS rows $ROWS 2>/dev/null || true
cd "$DEMO_PROJECT"
echo "firman@laptop:~/koniciwa\\\$ aegisxmemory init"
aegisxmemory init
sleep 0.8
echo "firman@laptop:~/koniciwa\\\$ aegisxmemory setup"
aegisxmemory setup
sleep 0.9
echo "firman@laptop:~/koniciwa\\\$ cat ~/.hermes/config.yaml"
cat "$DEMO_HOME/.hermes/config.yaml"
sleep 0.7
echo "firman@laptop:~/koniciwa\\\$ head -7 ~/.hermes/SOUL.md"
head -7 "$DEMO_HOME/.hermes/SOUL.md"
sleep 0.3
exit 0
SESSION
chmod +x "$WORK/record.sh"

# 3. Record on a PTY with `script`'s advanced timing log, feeding the wizard
#    answers ("1" = Hermes, "y" = auto-memory rules) with human-ish pacing.
{ sleep 2.0; printf '1'; sleep 0.35; printf '\n'; sleep 0.65; printf 'y'; sleep 0.35; printf '\n'; sleep 5.0; } \
  | timeout 60 script -q -m advanced -T "$WORK/time.log" -O "$WORK/out.log" -c "$WORK/record.sh" >/dev/null

# 4. Convert script(1)'s timing log + output log into asciicast v2 for agg.
cat > "$WORK/to-cast.mjs" <<'CONVERTER'
import fs from 'node:fs';

const [timePath, outPath, castPath] = process.argv.slice(2);
const timeLog = fs.readFileSync(timePath, 'utf8');
const out = fs.readFileSync(outPath, 'utf8');

// `script -m advanced` writes: H <offset> <KEY> <value> header lines and
// O <offset> <bytes> output records — one per chunk written to the terminal.
const events = [];
for (const line of timeLog.split('\n')) {
  if (!line.startsWith('O ')) continue;
  const [offset, bytes] = line.slice(2).split(' ');
  events.push({ time: Number(offset), bytes: Number(bytes) });
}

// script(1) brackets the capture with a "Script started ..." banner and a
// trailing "Script done ..." line. Neither belongs on screen, and the final O
// record can include the first bytes of the trailer, so the safe end is
// whichever comes first: the sum of the recorded byte counts, or the trailer.
const start = out.startsWith('Script started') ? out.indexOf('\n') + 1 : 0;
const total = events.reduce((sum, event) => sum + event.bytes, 0);
const trailer = out.lastIndexOf('Script done on');
const end = trailer === -1 ? start + total : Math.min(start + total, trailer - 1);
if (start <= 0 || total <= 0 || end <= start) {
  console.error('unexpected script(1) logs — cannot build a cast');
  process.exit(1);
}

const lines = [
  JSON.stringify({
    version: 2,
    width: 110,
    height: 34,
    timestamp: Math.floor(Date.now() / 1000),
    env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
  }),
];
let cursor = start;
for (const event of events) {
  if (cursor >= end) break;
  const next = Math.min(cursor + event.bytes, end);
  lines.push(JSON.stringify([Number(event.time.toFixed(6)), 'o', out.slice(cursor, next)]));
  cursor = next;
}
fs.writeFileSync(castPath, lines.join('\n') + '\n');
CONVERTER

node "$WORK/to-cast.mjs" "$WORK/time.log" "$WORK/out.log" "$WORK/demo.cast"

# 5. Render.
agg --cols "$COLS" --rows "$ROWS" --font-size 15 --theme dracula \
    --last-frame-duration 4 --idle-time-limit 2 "$WORK/demo.cast" "$OUT"
echo "Wrote $OUT"
