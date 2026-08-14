#!/usr/bin/env bash
#
# Ship a movi-player release.
#
# The version bump itself is NOT here — that is `npm run release -- <version>`
# (see scripts/release.mjs and the release-manager agent). By the time you run
# this, the bump is committed and the changelog is stamped. This walks what is
# left: build, package, push, tag, deploy, publish.
#
#   ./scripts/release-run.sh              # walk every phase, confirming each
#   ./scripts/release-run.sh --from 5     # resume at phase 5
#   ./scripts/release-run.sh --only 6     # run one phase
#   ./scripts/release-run.sh --dry        # print what each phase would run
#   ./scripts/release-run.sh --no-wasm    # skip the Docker WASM build
#
# Every phase that reaches outside this machine — push, tag, deploy, publish —
# asks first, and a "no" stops the run rather than skipping ahead.

set -euo pipefail
cd "$(dirname "$0")/.."

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'

FROM=1; ONLY=""; DRY=0; WASM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --only) ONLY="$2"; FROM="$2"; shift 2 ;;
    --dry) DRY=1; shift ;;
    --no-wasm) WASM=0; shift ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "${R}unknown flag: $1${N}"; exit 2 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

# release.mjs --package writes each artefact next to the thing it packages, not
# into the repo root. Spelled out rather than globbed: an unmatched glob is left
# as a literal by the shell and gets handed to the tool as a filename.
VSIX="vscode-extension/movi-player-vscode-${VERSION}.vsix"
CHROME_ZIP="chrome-extension/movi-player-${VERSION}.zip"
FF_ZIP="firefox-extension/movi-player-firefox-${VERSION}.zip"

say()  { printf '\n%s\n' "${B}${C}▸ $*${N}"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  %s\n' "${Y}! $*${N}"; }
die()  { printf '\n%s\n' "${R}✗ $*${N}"; exit 1; }

# Run a command, or print it under --dry.
run() {
  if [ "$DRY" = 1 ]; then printf '  %s\n' "${DIM}\$ $*${N}"; return 0; fi
  printf '  %s\n' "${DIM}\$ $*${N}"
  "$@"
}

# Outward steps ask first. Answering no stops the run — the phases after this
# one assume it happened.
confirm() {
  [ "$DRY" = 1 ] && { printf '  %s\n' "${DIM}(would ask: $1)${N}"; return 0; }
  printf '\n  %s ' "${Y}$1${N} ${DIM}[y/N]${N}"
  read -r a </dev/tty
  case "$a" in y|Y|yes) return 0 ;; *) die "stopped at your request" ;; esac
}

phase() {
  local n="$1"
  [ -n "$ONLY" ] && [ "$ONLY" != "$n" ] && return 1
  [ "$n" -lt "$FROM" ] && { printf '  %s\n' "${DIM}· phase $n skipped${N}"; return 1; }
  return 0
}

printf '%s\n' "${B}movi-player ${VERSION} — release${N}"
[ "$DRY" = 1 ] && warn "dry run: nothing will actually run"

# ── 0 · Preflight ─────────────────────────────────────────────────────────────
say "0 · Preflight"
[ -n "$(git status --porcelain)" ] && die "working tree is dirty — commit or stash first"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "develop" ] || die "on '$BRANCH' — releases are cut from develop"
git rev-parse "$TAG" >/dev/null 2>&1 && die "$TAG already exists — bump the version first"
info "branch develop · tree clean · $TAG is free"

# Every package must already carry this version. Catches a half-finished bump.
for f in package.json desktop/package.json vscode-extension/package.json; do
  v="$(node -p "require('./$f').version")"
  [ "$v" = "$VERSION" ] || die "$f is $v, expected $VERSION"
done
for f in chrome-extension/manifest.json firefox-extension/manifest.json; do
  v="$(node -p "require('./$f').version")"
  [ "$v" = "$VERSION" ] || die "$f is $v, expected $VERSION"
done
info "all 5 packages at $VERSION"

grep -q "^## \[${VERSION}\]" CHANGELOG.md || die "CHANGELOG.md has no ## [$VERSION] section"
grep -q "^## \[${VERSION}\]" docs/changelog.md || die "docs/changelog.md has no ## [$VERSION] section"
info "both changelogs stamped"

run npx tsc --noEmit

# ── 1 · Build ─────────────────────────────────────────────────────────────────
if phase 1; then
  say "1 · Build"
  if [ "$WASM" = 1 ]; then
    info "full build including WASM (Docker) — pass --no-wasm to reuse dist/wasm"
    run npm run build
  else
    run npm run build:ts
  fi
fi

# ── 2 · Sync the bundle into every target ─────────────────────────────────────
if phase 2; then
  say "2 · Sync element.js → extensions + desktop"
  info "the build does NOT do this; the extensions ship their own copy"
  run npm run sync:element
fi

# ── 3 · Verify the bundle ─────────────────────────────────────────────────────
# A tsc-only build leaves dist/element.js as a ~3KB re-export shim that imports
# ./utils/Logger.js and friends. It loads fine from dist/ and fails everywhere
# it is copied to, as thirty 404s. Cheap to check, miserable to debug live.
if phase 3; then
  say "3 · Verify the built bundle"
  if [ "$DRY" = 0 ]; then
    for f in dist/element.js dist/element.slim.js dist/movi.wasm \
             chrome-extension/dist/element.js firefox-extension/dist/element.js \
             vscode-extension/webview/dist/element.js; do
      [ -f "$f" ] || die "missing: $f"
      sz=$(wc -c < "$f")
      [ "$sz" -gt 1000000 ] || die "$f is only $((sz/1024))KB — that is the tsc shim, not a bundle"
      printf '  %s %s\n' "${G}✓${N}" "$f ($((sz/1024/1024))MB)"
    done
    grep -q "$VERSION" dist/element.js || die "dist/element.js does not carry $VERSION"
    info "${G}✓${N} version $VERSION baked into the bundle"
  fi
fi

# ── 4 · Package the extensions ────────────────────────────────────────────────
if phase 4; then
  say "4 · Package .vsix + chrome/firefox zips"
  run npm run release -- "$VERSION" --package
  if [ "$DRY" = 0 ]; then
    for f in "$VSIX" "$CHROME_ZIP" "$FF_ZIP"; do
      [ -f "$f" ] || die "expected $f — packaging did not produce it"
      printf '  %s %s (%s)\n' "${G}✓${N}" "$f" "$(du -h "$f" | cut -f1)"
    done
  fi
fi

# ── 5 · Git: push develop, merge to main, tag ─────────────────────────────────
if phase 5; then
  say "5 · Push develop, merge into main, tag"
  info "$(git rev-list --count origin/develop..develop) commits ahead of origin/develop"
  confirm "push develop to origin?"
  run git push origin develop

  # --no-ff, never squash. A squash rewrites every contributor's commit as
  # yours: their work vanishes from the contributors graph, and a PR whose
  # commits land under new SHAs is never marked merged.
  confirm "merge develop into main (--no-ff, no squash)?"
  run git checkout main
  run git merge --no-ff develop -m "Merge branch 'develop' for $TAG"
  run git push origin main

  confirm "tag $TAG and push it?"
  run git tag -a "$TAG" -m "$TAG"
  run git push origin "$TAG"

  # Back onto develop, carrying the merge commit, so the branches do not drift.
  run git checkout develop
  run git merge --no-ff main -m "Merge branch 'main' into develop after $TAG"
  run git push origin develop
fi

# ── 6 · Deploy web app + docs ─────────────────────────────────────────────────
if phase 6; then
  say "6 · Deploy the web app and the docs site"
  confirm "upload assets to R2 and deploy the worker?"
  run npm run app:upload
  run npm run app:deploy
  # app:deploy stamps a build id into worker.js and restores it afterwards. It
  # has been seen to leave both behind when it exits early.
  if [ "$DRY" = 0 ] && { [ -f app/worker.js.bak ] || ! git diff --quiet app/worker.js; }; then
    warn "app/worker.js was left modified (and/or worker.js.bak remains)"
    warn "restore with: mv app/worker.js.bak app/worker.js"
  fi

  # moviplayer.com/docs is a reverse proxy in front of GitHub Pages, so the
  # docs site only moves when gh-pages is pushed. Skipping this leaves the
  # changelog and the version nav showing the previous release.
  confirm "build and publish the docs site to GitHub Pages?"
  run npm run docs:deploy
fi

# ── 7 · Publish ───────────────────────────────────────────────────────────────
if phase 7; then
  say "7 · Publish"
  confirm "npm publish (needs npm login + 2FA)?"
  run npm publish

  # From inside vscode-extension: that is where vsce and the publisher identity
  # live. --packagePath takes the already-built .vsix so this publishes exactly
  # what phase 4 produced rather than repackaging from the working tree.
  [ "$DRY" = 0 ] && [ ! -f "$VSIX" ] && die "no $VSIX — run phase 4 first"
  confirm "publish the VS Code extension with vsce?"
  run bash -c "cd vscode-extension && npx vsce publish --packagePath '$(basename "$VSIX")'"
fi

# ── 8 · What is left for a human ──────────────────────────────────────────────
say "8 · By hand — no CLI does these"
cat <<EOF
  · Chrome Web Store  — upload $CHROME_ZIP
                        https://chrome.google.com/webstore/devconsole
  · Firefox Add-ons   — submit $FF_ZIP
                        https://addons.mozilla.org/developers/
  · GitHub release    — attach the artefacts to $TAG, paste the changelog section
  · Open issues/PRs   — reply to anything this release resolves. Draft each one,
                        show it, and post only after that reply is approved.
EOF

if [ "$DRY" = 0 ]; then
  printf '\n  %s\n' "${DIM}resolved by this release, if the notes say so:${N}"
  gh issue list --state open --limit 20 \
    --json number,title --template '{{range .}}  #{{.number}} {{.title}}{{"\n"}}{{end}}' 2>/dev/null \
    || printf '  %s\n' "${DIM}(gh not available)${N}"
fi

printf '\n%s\n' "${G}${B}✓ $TAG${N}"
