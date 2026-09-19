#!/usr/bin/env bash
#
# Local CI for Textmint. The pre-commit hook, the pre-push hook and GitHub
# Actions all call this same script, so a green run here is a green run there.
#
#   scripts/check.sh          full run (includes cargo check)
#   scripts/check.sh --fast   skip cargo check, for the pre-commit hook
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

# 1. src/main.js is ASCII only. Every non-ASCII codepoint must be a \u escape,
#    or the Unicode-stripping regexes can be silently corrupted by an editor.
if need_file src/main.js; then
  ASCII_HITS=$(LC_ALL=C grep -n "$(printf '[^ -~\t]')" src/main.js)
  if [ -n "$ASCII_HITS" ]; then
    fail "ASCII invariant: non-ASCII codepoints in src/main.js"
    printf '%s\n' "$ASCII_HITS" | sed 's/^/        /'
  else
    pass "ASCII invariant (src/main.js)"
  fi
fi

# 2. Syntax. There is no test framework, so this is the only automated gate
#    on the cleaning pipeline.
if [ "$HAVE_NODE" = "1" ] && [ -f src/main.js ]; then
  if NODE_ERR=$(node --check src/main.js 2>&1); then
    pass "node --check src/main.js"
  else
    fail "node --check src/main.js"
    printf '%s\n' "$NODE_ERR" | sed 's/^/        /'
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

# 4. A version bump has to touch all four places. The footer span carries only
#    major.minor (v0.2); the other three carry the full version (0.2.0).
if [ "$HAVE_NODE" = "1" ] && [ -f package.json ] && [ -f src-tauri/tauri.conf.json ] \
   && [ -f src-tauri/Cargo.toml ] && [ -f src/index.html ]; then
  V_PKG=$(read_json_field package.json version)
  V_TAURI=$(read_json_field src-tauri/tauri.conf.json version)
  V_CARGO=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
  V_FOOT=$(sed -n 's/.*class="footer-version">v\([^<]*\)<.*/\1/p' src/index.html | head -1)
  V_SHORT=$(printf '%s' "$V_PKG" | cut -d. -f1,2)

  if [ -z "$V_PKG" ] || [ -z "$V_CARGO" ] || [ -z "$V_FOOT" ]; then
    fail "could not read a version"
    printf '        package.json=%s tauri.conf.json=%s Cargo.toml=%s footer=%s\n' \
      "${V_PKG:-<none>}" "${V_TAURI:-<none>}" "${V_CARGO:-<none>}" "${V_FOOT:-<none>}"
  elif [ "$V_PKG" = "$V_TAURI" ] && [ "$V_PKG" = "$V_CARGO" ] && [ "$V_FOOT" = "$V_SHORT" ]; then
    pass "version agrees in all four files ($V_PKG)"
  else
    fail "version mismatch"
    printf '        package.json=%s tauri.conf.json=%s Cargo.toml=%s footer=v%s (expected v%s)\n' \
      "$V_PKG" "$V_TAURI" "$V_CARGO" "$V_FOOT" "$V_SHORT"
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
if [ "$FAST" = "1" ]; then
  skip "cargo check (--fast)"
elif ! command -v cargo >/dev/null 2>&1; then
  fail "cargo not found on PATH"
elif ! need_file src-tauri/Cargo.toml; then
  :
elif CARGO_ERR=$(cd src-tauri && cargo check --quiet 2>&1); then
  pass "cargo check"
else
  fail "cargo check"
  printf '%s\n' "$CARGO_ERR" | sed 's/^/        /'
fi

echo
if [ "$FAILED" = "1" ]; then
  echo "checks FAILED"
  exit 1
fi
echo "checks passed"
