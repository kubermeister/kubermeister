#!/usr/bin/env bash
# Regenerate the app icon set (png, icns, ico) from icon.svg.
# Requires: rsvg-convert, iconutil (macOS), magick (ImageMagick).
set -euo pipefail
cd "$(dirname "$0")"

for base in icon; do
    # 1024 master PNG (Linux icon)
    rsvg-convert -w 1024 -h 1024 "$base.svg" -o "$base.png"

    # macOS .icns via an iconset of all required sizes
    iconset="$base.iconset"
    rm -rf "$iconset"
    mkdir -p "$iconset"
    for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
                "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" \
                "512:512x512" "1024:512x512@2x"; do
        px="${spec%%:*}"
        name="${spec##*:}"
        rsvg-convert -w "$px" -h "$px" "$base.svg" -o "$iconset/icon_${name}.png"
    done
    iconutil -c icns "$iconset" -o "$base.icns"
    rm -rf "$iconset"

    # Windows .ico
    magick "$base.png" -define icon:auto-resize=256,128,64,48,32,16 "$base.ico"

    echo "Generated: $base.png $base.icns $base.ico"
done
