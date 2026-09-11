#!/usr/bin/env sh
# AegisX-Memory installer — one line from GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/aegisxresearch/AegisX-Memory/main/install.sh | sh
#
# What it does:
#   1. clones this repo into ~/.aegisx-app (git pull if it already exists)
#   2. installs dependencies (npm ci, falls back to npm install)
#   3. builds the TypeScript bundle (npm run build)
#   4. symlinks the `aegisxmemory` CLI into ~/.local/bin (falls back /usr/local/bin)
#   5. runs `aegisxmemory init` to create the memory home + database
#
# Requirements: node >= 20, npm, git.
set -eu

REPO_URL="${AEGISX_REPO_URL:-https://github.com/aegisxresearch/AegisX-Memory.git}"
APP_DIR="${AEGISX_APP_DIR:-$HOME/.aegisx-app}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
command -v node >/dev/null 2>&1 || fail "node is required (>= 20): https://nodejs.org"
command -v npm  >/dev/null 2>&1 || fail "npm is required (ships with node)"
command -v git  >/dev/null 2>&1 || fail "git is required: https://git-scm.com"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "node >= 20 required, found $(node --version)"

# ------------------------------------------------------------------ get sources
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout at $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  log "Cloning AegisX-Memory into $APP_DIR"
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

# -------------------------------------------------------------- install + build
log "Installing dependencies"
(cd "$APP_DIR" && (npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund))

log "Building"
(cd "$APP_DIR" && npm run --silent build)

[ -f "$APP_DIR/dist/cli/index.js" ] || fail "build output missing: $APP_DIR/dist/cli/index.js"

# ------------------------------------------------------------------ symlink CLI
BIN_DIR="${AEGISX_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
if ! ln -sfn "$APP_DIR/dist/cli/index.js" "$BIN_DIR/aegisxmemory" 2>/dev/null; then
  fail "cannot write $BIN_DIR/aegisxmemory (set AEGISX_BIN_DIR to a writable dir)"
fi
chmod +x "$APP_DIR/dist/cli/index.js" 2>/dev/null || true

# Remove the symlink from the pre-1.0 `aegisx` name, if present.
if [ -L "$BIN_DIR/aegisx" ] && [ "$(readlink "$BIN_DIR/aegisx" 2>/dev/null)" = "$APP_DIR/dist/cli/index.js" ]; then
  rm -f "$BIN_DIR/aegisx"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log "Note: $BIN_DIR is not on your PATH"
    SHELL_RC="$HOME/.profile"
    [ -n "${ZSH_VERSION:-}" ] && SHELL_RC="$HOME/.zshrc"
    if ! grep -qs "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
      printf '\n# added by AegisX-Memory installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$SHELL_RC"
      log "Appended PATH export to $SHELL_RC (open a new shell or: source $SHELL_RC)"
    fi
    ;;
esac

# ---------------------------------------------------------------------- init DB
log "Initializing memory home (~/.aegisx)"
"$BIN_DIR/aegisxmemory" init

printf '\n\033[1;32mAegisX-Memory installed!\033[0m\n'
printf '  CLI:     aegisxmemory --help\n'
printf '  Try:     cd your-project && aegisxmemory index . && aegisxmemory recall\n'
printf '  MCP:     aegisxmemory mcp-config --install --agent hermes   # auto-register in your agent\n'
printf '  Sources: %s\n' "$APP_DIR"
