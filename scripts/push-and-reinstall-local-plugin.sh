#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to push with uncommitted changes." >&2
  exit 1
fi

git push "$@"
codex plugin add pstack-for-codex@pstack-for-codex-local
