#!/usr/bin/env sh
# AegisX-Memory installer — one line from GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/aegisxresearch/AegisX-Memory/main/install.sh | sh
#
# Safe to re-run: it updates an existing checkout to the newest revision of the
# ref and rebuilds, so the same one-liner is also the upgrade path.
#
# What it does:
#   1. fetches the newest revision of the ref (default: main) into ~/.aegisx-app
#   2. installs dependencies (npm ci, falls back to npm install)
#   3. builds the TypeScript bundle (npm run build)
#   4. symlinks the `aegisxmemory` CLI into ~/.local/bin
#   5. runs `aegisxmemory init` to create the memory home + database
#   6. prints the version it installed, so you never have to guess which one
#
# Requirements: node >= 20, npm, git.
#
# Options:
#   -h, --help         this screen
#       --ref <ref>    branch or tag to install (default: main). A bare commit
#                      works only if your remote lets you fetch one — GitHub's
#                      does not, so pin a tag instead
#       --dir <path>   where the sources live (default: ~/.aegisx-app)
#       --bin <dir>    where the CLI symlink goes (default: ~/.local/bin)
#       --force        discard a checkout that cannot be updated in place
#       --no-init      skip `aegisxmemory init`
#       --no-path      never touch your shell rc file
#
# Environment: AEGISX_REPO_URL, AEGISX_REF, AEGISX_APP_DIR, AEGISX_BIN_DIR.
set -eu

REPO_URL="${AEGISX_REPO_URL:-https://github.com/aegisxresearch/AegisX-Memory.git}"
APP_DIR="${AEGISX_APP_DIR:-$HOME/.aegisx-app}"
BIN_DIR="${AEGISX_BIN_DIR:-$HOME/.local/bin}"
REF="${AEGISX_REF:-main}"
FORCE=0
DO_INIT=1
DO_PATH=1

log() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

usage() {
  # Literal, not scraped from $0: under `curl | sh` there is no file to read,
  # and a shell that cannot find $0 must not turn --help into an error.
  cat <<'USAGE'
AegisX-Memory installer — safe to re-run; re-running is how you upgrade.

  curl -fsSL https://raw.githubusercontent.com/aegisxresearch/AegisX-Memory/main/install.sh | sh
  curl -fsSL .../install.sh | sh -s -- --ref v1.0.0 --no-init

Options:
  -h, --help         this screen
      --ref <ref>    branch or tag to install (default: main)
      --dir <path>   where the sources live (default: ~/.aegisx-app)
      --bin <dir>    where the CLI symlink goes (default: ~/.local/bin)
      --force        discard a checkout that cannot be updated in place
      --no-init      skip `aegisxmemory init`
      --no-path      never touch your shell rc file

Environment: AEGISX_REPO_URL, AEGISX_REF, AEGISX_APP_DIR, AEGISX_BIN_DIR.
Requires: node >= 20, npm, git.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --force) FORCE=1; shift ;;
    --no-init) DO_INIT=0; shift ;;
    --no-path) DO_PATH=0; shift ;;
    --ref|--dir|--bin)
      # A flag that takes a value must actually receive one — an empty REF would
      # silently install whatever `git fetch` defaults to.
      [ $# -ge 2 ] || fail "$1 needs a value"
      case "$1" in
        --ref) REF="$2" ;;
        --dir) APP_DIR="$2" ;;
        --bin) BIN_DIR="$2" ;;
      esac
      shift 2
      ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$REF" ] || fail "--ref cannot be empty"

# ---------------------------------------------------------------- prerequisites
command -v node >/dev/null 2>&1 || fail "node is required (>= 20): https://nodejs.org"
command -v npm  >/dev/null 2>&1 || fail "npm is required (ships with node)"
command -v git  >/dev/null 2>&1 || fail "git is required: https://git-scm.com"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "node >= 20 required, found $(node --version)"

# Reachability first, so a private or mistyped repository reports itself here
# instead of as a wall of git output halfway through the install. `ls-remote`
# exits 0 for a ref it cannot find, so the *output* is the signal, not the code.
if [ -z "$(git ls-remote --heads --tags "$REPO_URL" 2>/dev/null)" ]; then
  fail "cannot read $REPO_URL.
       if the repository is private, make it public or point AEGISX_REPO_URL at a URL you can clone"
fi
if [ -z "$(git ls-remote "$REPO_URL" "$REF" 2>/dev/null)" ]; then
  # A bare commit is a legitimate --ref but is not a listed ref, so only a
  # non-SHA name can be reported as wrong here; a SHA is left to the fetch.
  case "$REF" in
    *[!0-9a-f]*|'') fail "unknown ref: $REF — pass --ref <branch|tag>" ;;
    *) [ "${#REF}" -ge 7 ] || fail "unknown ref: $REF — pass --ref <branch|tag>" ;;
  esac
  note "$REF is not a listed ref: trying it as a commit (your remote must allow fetching one)"
fi

# ------------------------------------------------------------------ get sources
# A fresh install (or a --force replacement) happens in a staging directory and
# is swapped in only after it builds. Deleting a working install first would
# mean a network hiccup during `npm ci` leaves you with no CLI at all.
WORK_DIR="$APP_DIR"
STAGE_DIR=""

if [ -d "$APP_DIR/.git" ] && [ "$FORCE" -eq 0 ]; then
  log "Updating existing checkout at $APP_DIR"
  # Fetch into FETCH_HEAD and reset onto it: `origin/$REF` is not tracked for a
  # tag, and a shallow clone's remote-tracking ref can lag.
  if ! git -C "$APP_DIR" fetch --depth 1 origin "$REF" 2>/dev/null; then
    fail "cannot update $APP_DIR from $REF.
       if $REF is a bare commit, GitHub refuses to serve one — pin a tag or branch instead
       to replace the checkout outright, re-run with --force"
  fi
  git -C "$APP_DIR" reset --hard FETCH_HEAD >/dev/null
else
  STAGE_DIR="$APP_DIR.staging.$$"
  WORK_DIR="$STAGE_DIR"
  # Clean the staging tree up however we leave, so a failed install does not
  # litter a half-built checkout next to the real one.
  trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM
  log "Cloning $REF into a staging checkout"
  rm -rf "$STAGE_DIR"
  # `--branch` accepts a branch or a tag but not a bare commit, so a commit ref
  # falls back to a fetch.
  if ! git clone --depth 1 --branch "$REF" "$REPO_URL" "$STAGE_DIR" 2>/dev/null; then
    rm -rf "$STAGE_DIR"
    git clone --depth 1 "$REPO_URL" "$STAGE_DIR" || fail "clone failed — check the network"
    git -C "$STAGE_DIR" fetch --depth 1 origin "$REF" 2>/dev/null \
      || fail "cannot fetch $REF — if it is a bare commit, pin a tag or branch instead"
    git -C "$STAGE_DIR" checkout -q FETCH_HEAD
  fi
fi

# -------------------------------------------------------------- install + build
log "Installing dependencies"
(cd "$WORK_DIR" && (npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund))

log "Building"
(cd "$WORK_DIR" && npm run --silent build)

[ -f "$WORK_DIR/dist/cli/index.js" ] || fail "build output missing: $WORK_DIR/dist/cli/index.js"

# The build proved itself: now (and only now) the staging checkout takes over.
if [ -n "$STAGE_DIR" ]; then
  rm -rf "$APP_DIR"
  mv "$STAGE_DIR" "$APP_DIR"
  trap - EXIT HUP INT TERM
  WORK_DIR="$APP_DIR"
  log "Installed into $APP_DIR"
fi

# ------------------------------------------------------------------ symlink CLI
mkdir -p "$BIN_DIR"
chmod +x "$APP_DIR/dist/cli/index.js" 2>/dev/null || true
ln -sfn "$APP_DIR/dist/cli/index.js" "$BIN_DIR/aegisxmemory" 2>/dev/null \
  || fail "cannot write $BIN_DIR/aegisxmemory (set AEGISX_BIN_DIR to a writable dir)"

# Remove the symlink from the pre-1.0 `aegisx` name, if it points at this install.
if [ -L "$BIN_DIR/aegisx" ] && [ "$(readlink "$BIN_DIR/aegisx" 2>/dev/null)" = "$APP_DIR/dist/cli/index.js" ]; then
  rm -f "$BIN_DIR/aegisx"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log "Note: $BIN_DIR is not on your PATH"
    if [ "$DO_PATH" -eq 1 ]; then
      # Pick the file this shell actually reads, instead of assuming ~/.profile:
      # a `curl | sh` runs under sh, so $ZSH_VERSION is empty even for a zsh user.
      case "$(basename "${SHELL:-sh}")" in
        zsh) SHELL_RC="$HOME/.zshrc" ;;
        bash)
          if [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
          elif [ -f "$HOME/.bash_profile" ]; then SHELL_RC="$HOME/.bash_profile"
          else SHELL_RC="$HOME/.profile"; fi
          ;;
        *) SHELL_RC="$HOME/.profile" ;;
      esac
      if ! grep -qs "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
        printf '\n# added by AegisX-Memory installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$SHELL_RC"
        note "Appended PATH export to $SHELL_RC (open a new shell or: . $SHELL_RC)"
      else
        note "$SHELL_RC already exports it — open a new shell to pick it up"
      fi
    else
      note "add it yourself: export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

# ---------------------------------------------------------------------- init DB
if [ "$DO_INIT" -eq 1 ]; then
  log "Initializing memory home (~/.aegisx)"
  "$BIN_DIR/aegisxmemory" init
fi

# ------------------------------------------------------------------- what you got
# Report the revision and the CLI's own version: "did I get the newest one?" is
# the first question an upgrade asks, and it should not need a second command.
REV=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)
WHEN=$(git -C "$APP_DIR" show -s --format=%cd --date=short HEAD 2>/dev/null || echo '')
VER=$("$BIN_DIR/aegisxmemory" --version 2>/dev/null || echo unknown)

printf '\n\033[1;32mAegisX-Memory installed!\033[0m\n'
printf '\n'
printf '  Version:  %s\n' "$VER"
printf '  Ref:      %s (%s%s)\n' "$REF" "$REV" "${WHEN:+ · $WHEN}"
printf '  Sources:  %s\n' "$APP_DIR"
printf '\n'
printf '\033[1mOne command left — answer 2 questions, done:\033[0m\n'
printf '  aegisxmemory setup\n'
printf '     (connects your agent + enables auto-memory; restart the agent after)\n'
printf '\n'
printf '  Prefer manual? aegisxmemory mcp-config --install --agent hermes --rules\n'
printf '  Update later:  curl -fsSL %s/raw/%s/install.sh | sh\n' \
  "${REPO_URL%.git}" "$REF"
printf '  Docs: README.md (English) · README.id.md (Bahasa Indonesia)\n'
