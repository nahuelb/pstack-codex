#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to push with uncommitted changes." >&2
  exit 1
fi

for argument in "$@"; do
  case "$argument" in
    --dry-run|-n|--delete|-d|:*)
      echo "Dry-run and deletion arguments are not supported by the release wrapper." >&2
      exit 1
      ;;
  esac
done

release_tree="$(git rev-parse 'HEAD^{tree}')"
PSTACK_LOCAL_PLUGIN_PUSH=1 git push "$@"
if ! node scripts/check-local-plugin-source.mjs "$repo_root" "$release_tree"; then
  echo "Push succeeded; plugin release blocked. Resolve the marketplace source mismatch before reinstalling." >&2
  exit 1
fi
if ! codex plugin add pstack-for-codex@pstack-for-codex-local; then
  echo "Push succeeded; plugin installation failed." >&2
  exit 1
fi
echo "Push and installation succeeded. Verify installed files and explicit invocation in a fresh task before claiming runtime availability."
