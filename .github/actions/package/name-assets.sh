#!/usr/bin/env bash
# Names what electron-builder left under release/ for this runner: the installers, and every
# electron-updater feed beside them. Writes both lists to $GITHUB_OUTPUT, one path per line.
#
# The feeds are found rather than named, because electron-builder writes one per OS and, on Linux,
# one per architecture: latest-linux.yml for x64, latest-linux-arm64.yml for arm64. A feed that is
# not uploaded fails nothing on its own — the installers are there, and the users of that build
# simply never hear of another version — so every way a feed can go missing fails here instead.
#
# Kept to bash 3.2, which is what /bin/bash still is on the macOS runners.
set -euo pipefail
shopt -s nullglob

fail() {
    echo "::error::$*"
    exit 1
}

case "${RUNNER_OS:-}" in
    macOS)
        installers=(release/*.dmg release/*.zip)
        blockmaps=(release/*.dmg.blockmap release/*.zip.blockmap)
        expected=latest-mac.yml
        ;;
    Windows)
        installers=(release/*.exe)
        blockmaps=(release/*.exe.blockmap)
        expected=latest.yml
        ;;
    Linux)
        installers=(release/*.AppImage release/*.deb)
        blockmaps=()
        # electron-updater asks for latest-linux.yml on x64 and latest-linux-<arch>.yml anywhere
        # else (getChannelFilePrefix in its Provider), whichever package type it is updating.
        case "${RUNNER_ARCH:-}" in
            X64) expected=latest-linux.yml ;;
            ARM64) expected=latest-linux-arm64.yml ;;
            *) fail "no Linux feed is known for the architecture '${RUNNER_ARCH:-}'" ;;
        esac
        ;;
    *) fail "no installers are known for the OS '${RUNNER_OS:-}'" ;;
esac

feeds=(release/latest*.yml)

[ "${#installers[@]}" -gt 0 ] || fail "no installers under release/"
[ "${#feeds[@]}" -gt 0 ] || fail "no updater metadata under release/"
[ -f "release/$expected" ] ||
    fail "the updater on this runner's OS and architecture reads $expected, which is not under release/"

# Two Linux runners upload to the same release, each its own architecture's feed. One of them
# writing the other's would overwrite a feed naming installers this runner never built.
if [ "$RUNNER_OS" = Linux ]; then
    for feed in "${feeds[@]}"; do
        [ "$(basename "$feed")" = "$expected" ] ||
            fail "$(basename "$feed") belongs to another architecture's runner; this one writes $expected"
    done
fi

names=""
for f in "${installers[@]}"; do
    names="$names$(basename "$f")"$'\n'
done

# What a feed names is what a running app downloads, so each name must be an installer this runner
# uploads and verifies; and an installer no feed names is one whose users are never offered an update.
named=""
for feed in "${feeds[@]}"; do
    listed=$(sed -n -E "s/^( *- url| *path): *['\"]?([^'\"]+)['\"]? *\$/\\2/p" "$feed")
    [ -n "$listed" ] || fail "$(basename "$feed") names no installer"
    while IFS= read -r name; do
        grep -qxF "$name" <<< "$names" || fail "$(basename "$feed") names $name, which is not under release/"
    done <<< "$listed"
    named="$named$listed"$'\n'
done
for f in "${installers[@]}"; do
    grep -qxF "$(basename "$f")" <<< "$named" || fail "no feed names $(basename "$f"), so its users never see an update"
done

{
    printf 'installers<<EOL\n'
    printf '%s\n' "${installers[@]}" ${blockmaps[@]+"${blockmaps[@]}"}
    printf 'EOL\n'
    printf 'feeds<<EOL\n'
    printf '%s\n' "${feeds[@]}"
    printf 'EOL\n'
} >> "$GITHUB_OUTPUT"

printf 'installer  %s\n' "${installers[@]}" ${blockmaps[@]+"${blockmaps[@]}"}
printf 'feed       %s\n' "${feeds[@]}"
