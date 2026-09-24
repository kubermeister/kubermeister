#!/usr/bin/env bash
# Reads every asset in $FILES (one path per line) back from the release $TAG and compares its size
# and checksum with the local file: an upload that returned success but stored something else must
# fail here, not on a user's machine.
set -euo pipefail

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
assets=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[] | "\(.name)\t\(.state)\t\(.size)\t\(.digest)"')
ok=true
while IFS= read -r f; do
    [ -n "$f" ] || continue
    name=$(basename "$f")
    expected=$(printf '%s\t%s\t%s\t%s' "$name" uploaded "$(wc -c < "$f" | tr -d ' ')" "sha256:$(sha256 "$f")")
    if grep -qxF "$expected" <<< "$assets"; then
        echo "ok  $name"
    else
        echo "::error::$name on the release does not match the packaged file"
        echo "  expected: $expected"
        echo "  release:  $(grep -F "$name" <<< "$assets" || echo '<missing>')"
        ok=false
    fi
done <<< "$FILES"
$ok
