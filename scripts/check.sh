#!/usr/bin/env bash
#
# Local CI for Textmint. The pre-commit hook, the pre-push hook and GitHub
# Actions all call this same script, so a green run here is a green run there.
#
#   scripts/check.sh          full run (includes cargo check and clippy)
#   scripts/check.sh --fast   skip the compiling Rust checks, for the pre-commit
#                             hook. cargo fmt still runs: it does not compile
#                             anything and costs well under a second.
#
# Install the hooks once with: git config core.hooksPath .githooks
#
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel) || { echo "not inside a git repository" >&2; exit 1; }
cd "$ROOT" || exit 1

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
skip() { printf '  skip  %s\n' "$1"; }

# Every check below reads a file. A missing file is a failure, never a pass:
# grep on a missing path returns nothing, which would otherwise look clean.
need_file() {
  [ -f "$1" ] && return 0
  fail "missing file: $1"
  return 1
}

echo "textmint checks"

HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1
[ "$HAVE_NODE" = "1" ] || fail "node not found on PATH (checks 2 to 4 need it)"

# 1. Every JS file we own is ASCII only: each non-ASCII codepoint must be a \u
#    escape, or an editor can silently corrupt it. pipeline.js holds the
#    regexes, and the tests hold the invisible characters those regexes target,
#    so a mangled test would pass vacuously. Globbed rather than listed so a new
#    file is covered the moment it exists, including scripts/regen-snapshots.js,
#    which builds the snapshots and so must not mangle them. The glob is used
#    directly rather than
#    through $(ls ...): word splitting would turn a path containing a space into
#    two entries and report a miss instead of a result. need_file skips the
#    unexpanded pattern if a directory is ever empty.
for f in src/*.js test/*.js scripts/*.js bin/*.js; do
  if need_file "$f"; then
    ASCII_HITS=$(LC_ALL=C grep -n "$(printf '[^ -~\t]')" "$f")
    if [ -n "$ASCII_HITS" ]; then
      fail "ASCII invariant: non-ASCII codepoints in $f"
      printf '%s\n' "$ASCII_HITS" | sed 's/^/        /'
    else
      pass "ASCII invariant ($f)"
    fi
  fi
done

# 2. Syntax. A parse error here would take the app down on launch, and it is
#    the cheapest gate to run, so it comes before the suite at 2b. Globbed over
#    src/ so a new module (src/bridge.js and any later one) is checked the
#    moment it exists, not only the two files that happened to exist first.
if [ "$HAVE_NODE" = "1" ]; then
  for f in src/*.js bin/*.js; do
    [ -f "$f" ] || continue
    if NODE_ERR=$(node --check "$f" 2>&1); then
      pass "node --check $f"
    else
      fail "node --check $f"
      printf '%s\n' "$NODE_ERR" | sed 's/^/        /'
    fi
  done
fi

# 2a. Build the render binary so the CLI html test at 2b exercises it instead of
#     skipping. Skipped under --fast (the pre-commit hook), which stays compile-free.
if [ "$FAST" != "1" ] && command -v cargo >/dev/null 2>&1; then
  if RENDER_ERR=$(cd src-tauri && cargo build --quiet --bin textmint-render 2>&1); then
    pass "cargo build --bin textmint-render"
  else
    fail "cargo build --bin textmint-render"
    printf '%s\n' "$RENDER_ERR" | sed 's/^/        /'
  fi
fi

# 2b. The pipeline and CLI test suites. This is the only thing that exercises the
#     cleaning passes; nothing else catches a regex that silently corrupts text.
if [ "$HAVE_NODE" = "1" ] && [ -d test ]; then
  if TEST_OUT=$(node --test test/ 2>&1); then
    pass "node --test ($(printf '%s' "$TEST_OUT" | sed -n 's/^# pass \([0-9]*\)/\1/p;s/^\xe2\x84\xb9 pass \([0-9]*\)/\1/p' | head -1) passing)"
  else
    fail "node --test"
    printf '%s\n' "$TEST_OUT" | grep -E "^(not ok|  *Error|✖)" | head -12 | sed 's/^/        /'
  fi
fi

# 3. Config files parse. A broken capabilities file builds fine and then fails
#    at runtime with a permission error.
read_json_field() {
  node -e "const v=JSON.parse(require('fs').readFileSync('$1','utf8'))['$2']; process.stdout.write(v==null?'':String(v))"
}
if [ "$HAVE_NODE" = "1" ]; then
  for f in package.json src-tauri/tauri.conf.json src-tauri/capabilities/default.json; do
    if need_file "$f"; then
      if node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null; then
        pass "valid JSON: $f"
      else
        fail "invalid JSON: $f"
      fi
    fi
  done
fi

# The dev-only MCP bridge's permission lives in dev-capabilities/, granted at
# runtime. Every build reads capabilities/, and a release build (which does not
# compile the plugin) fails on a permission for a plugin it lacks.
if grep -rqs "mcp-bridge" src-tauri/capabilities/; then
  fail "mcp-bridge permission in src-tauri/capabilities/ (it belongs in dev-capabilities/)"
else
  pass "no dev-only permission in capabilities/"
fi

# 4. A version bump has to touch all four places, and all four carry the full
#    version: the footer span reads v0.2.0 against 0.2.0 in the other three.
if [ "$HAVE_NODE" = "1" ] && [ -f package.json ] && [ -f src-tauri/tauri.conf.json ] \
   && [ -f src-tauri/Cargo.toml ] && [ -f src/index.html ]; then
  V_PKG=$(read_json_field package.json version)
  V_TAURI=$(read_json_field src-tauri/tauri.conf.json version)
  V_CARGO=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
  V_FOOT=$(sed -n 's/.*class="footer-version">v\([^<]*\)<.*/\1/p' src/index.html | head -1)

  if [ -z "$V_PKG" ] || [ -z "$V_CARGO" ] || [ -z "$V_FOOT" ]; then
    fail "could not read a version"
    printf '        package.json=%s tauri.conf.json=%s Cargo.toml=%s footer=%s\n' \
      "${V_PKG:-<none>}" "${V_TAURI:-<none>}" "${V_CARGO:-<none>}" "${V_FOOT:-<none>}"
  elif [ "$V_PKG" = "$V_TAURI" ] && [ "$V_PKG" = "$V_CARGO" ] && [ "$V_FOOT" = "$V_PKG" ]; then
    pass "version agrees in all four files ($V_PKG)"
  else
    fail "version mismatch"
    printf '        package.json=%s tauri.conf.json=%s Cargo.toml=%s footer=v%s (expected v%s)\n' \
      "$V_PKG" "$V_TAURI" "$V_CARGO" "$V_FOOT" "$V_PKG"
  fi
fi

# npm does not rewrite package-lock.json's own version on a hand bump, so it sat
# at 0.2.0 through 0.6.0 unnoticed. It follows package.json.
if [ "$HAVE_NODE" = "1" ] && [ -f package-lock.json ] && [ -f package.json ]; then
  V_LOCK=$(read_json_field package-lock.json version)
  V_LOCK_ROOT=$(node -p 'require("./package-lock.json").packages[""].version' 2>/dev/null)
  if [ "$V_LOCK" = "$(read_json_field package.json version)" ] && [ "$V_LOCK_ROOT" = "$V_LOCK" ]; then
    pass "package-lock.json version matches ($V_LOCK)"
  else
    fail "package-lock.json version is $V_LOCK; run: npm install --package-lock-only"
  fi
fi

# 5. Colors come from --clr-* tokens. A raw hex is allowed only where the
#    tokens are defined; anywhere else it bypasses the light theme.
#    Scoped to styles.css: index.html holds the inline SVG logo and HTML
#    entities, neither of which this rule covers.
if need_file src/styles.css; then
  HEX_HITS=$(grep -nE '#[0-9a-fA-F]{3,8}' src/styles.css | grep -vE ':[[:space:]]*--clr-')
  if [ -n "$HEX_HITS" ]; then
    fail "raw hex outside the token blocks in src/styles.css"
    printf '%s\n' "$HEX_HITS" | sed 's/^/        /'
  else
    pass "no raw hex outside token blocks (src/styles.css)"
  fi
fi

# 6. Rust. Runs from src-tauri because there is no workspace manifest at the root.
#
# A missing component is a failure, not a skip, with the rustup line to fix it:
# this script is the one definition of valid, so a check that quietly does not
# run is worse than one that is red. clippy and cargo check do not invalidate
# each other's target dir, so running both costs under a second warm.
HAVE_CARGO=0
if ! command -v cargo >/dev/null 2>&1; then
  fail "cargo not found on PATH"
elif need_file src-tauri/Cargo.toml; then
  HAVE_CARGO=1
fi

# 6a. Formatting. No compilation, so it runs even under --fast.
if [ "$HAVE_CARGO" = "1" ]; then
  if ! cargo fmt --version >/dev/null 2>&1; then
    fail "rustfmt not installed (rustup component add rustfmt)"
  elif FMT_ERR=$(cd src-tauri && cargo fmt --check 2>&1); then
    pass "cargo fmt --check"
  else
    fail "cargo fmt --check (run: cd src-tauri && cargo fmt)"
    printf '%s\n' "$FMT_ERR" | sed 's/^/        /'
  fi
fi

# 6b. Type check and lints. These compile, so --fast skips them.
if [ "$HAVE_CARGO" != "1" ]; then
  :
elif [ "$FAST" = "1" ]; then
  skip "cargo check and clippy (--fast)"
else
  if CARGO_ERR=$(cd src-tauri && cargo check --quiet 2>&1); then
    pass "cargo check"
  else
    fail "cargo check"
    printf '%s\n' "$CARGO_ERR" | sed 's/^/        /'
  fi

  # The Rust unit tests. Added with the Phase 1 core: they pin the four patterns
  # the regex crate cannot take, and prove the backtrack limit fires instead of
  # hanging. Untested Rust would rot exactly as fast as untested JS did.
  if CARGO_TEST_ERR=$(cd src-tauri && cargo test --quiet 2>&1); then
    pass "cargo test"
  else
    fail "cargo test"
    printf '%s\n' "$CARGO_TEST_ERR" | sed 's/^/        /'
  fi

  # --all-targets so tests and benches are linted too, not just the binary.
  # -D warnings makes a lint fatal, which is the point; it also means a
  # toolchain bump that adds a lint can turn this red on unchanged code.
  if ! cargo clippy --version >/dev/null 2>&1; then
    fail "clippy not installed (rustup component add clippy)"
  else
    if CLIPPY_ERR=$(cd src-tauri && cargo clippy --all-targets --quiet -- -D warnings 2>&1); then
      pass "cargo clippy"
    else
      fail "cargo clippy"
      printf '%s\n' "$CLIPPY_ERR" | sed 's/^/        /'
    fi
    # The dev-only MCP bridge sits behind the `mcp` feature, which no default
    # build turns on, so without this its wiring in lib.rs could rot unnoticed.
    if MCP_ERR=$(cd src-tauri && cargo clippy --all-targets --features mcp --quiet -- -D warnings 2>&1); then
      pass "cargo clippy --features mcp"
    else
      fail "cargo clippy --features mcp"
      printf '%s\n' "$MCP_ERR" | sed 's/^/        /'
    fi
  fi
fi

echo
if [ "$FAILED" = "1" ]; then
  echo "checks FAILED"
  exit 1
fi
echo "checks passed"
