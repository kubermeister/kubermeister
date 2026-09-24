#!/usr/bin/env bash
# Uploads every file in $FILES (one path per line) to the release $TAG, one file per call, retried
# with backoff: GitHub's upload service fails a large asset now and then with a 5xx, and one such
# failure must not cost the whole build. `--clobber` only ever meets an asset of this same version,
# left by a failed attempt or a rerun of the job, or the feed this runner rewrites in place.
set -euo pipefail

retry() {
    local attempt=1 delay=15
    until "$@"; do
        if [ "$attempt" -ge 5 ]; then
            echo "::error::gave up after $attempt attempts: $*"
            return 1
        fi
        echo "::warning::attempt $attempt failed: $*; retrying in ${delay}s"
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

while IFS= read -r f; do
    [ -n "$f" ] || continue
    retry gh release upload "$TAG" "$f" --repo "$GITHUB_REPOSITORY" --clobber < /dev/null
done <<< "$FILES"
