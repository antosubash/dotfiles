#!/usr/bin/env bash
# Turn off every device OpenRGB detects. Uses the device's "Off" mode when it
# has one; otherwise sets it to black, since not every controller offers "Off".
# Installed as /usr/local/sbin/rgb-off by setup-rgb-off.sh and run at boot by
# rgb-off.service.
#
# Every openrgb call runs its own detection pass, and at boot the I2C/SMBus can
# time out, so the call that applies the modes may see fewer devices than the
# pass the arguments were built from. One index that is no longer there makes
# OpenRGB reject the whole call ("Error: Empty device ID") and change nothing.
# So: detect and apply in one call, up to 3 times; if every try fails, turn the
# devices from the last detection that found any off one call each, and count
# what worked. Each call is killed 5 s after its timeout if it ignores SIGTERM.
#
# Exit status: 0 when at least one device was turned off, 1 when none was.
# RGB_OFF_RETRY_SLEEP overrides the pause between tries (for tests).
set -u

retry_sleep="${RGB_OFF_RETRY_SLEEP:-5}"
list=""
# One entry per device, e.g. "--device 0 --mode off".
devices=()
# The last detection that found devices, for the one-device-at-a-time fallback.
found=()
found_list=""

# Fill $list and $devices from a fresh detection pass.
detect() {
    devices=()
    list="$(timeout -k 5 60 openrgb --noautoconnect --list-devices 2>/dev/null)"
    # Device headers look like "0: Name"; the mode list like "  Modes: [Direct] Off Static".
    # OpenRGB can print an HTML warning on stdout ahead of the first header, so
    # match headers anywhere on an unindented line, and never emit an empty index.
    while read -r idx modes; do
        if grep -qiw 'off' <<< "$modes"; then
            devices+=("--device $idx --mode off")
        elif grep -qiw 'static' <<< "$modes"; then
            devices+=("--device $idx --mode static --color 000000")
        else
            devices+=("--device $idx --mode direct --color 000000")
        fi
    done < <(awk '!/^[ \t]/ && match($0, /[0-9]+: [^ ]/) {idx = substr($0, RSTART); sub(/:.*/, "", idx)}
        /^ *Modes:/ && idx != "" {sub(/^ *Modes: */, ""); print idx, $0}' <<< "$list")
}

# print_list TEXT: the device list a decision was made from.
print_list() {
    echo "rgb-off: device list was:" >&2
    echo "$1" >&2
}

for attempt in 1 2 3; do
    [ "$attempt" -gt 1 ] && sleep "$retry_sleep"
    detect
    if [ ${#devices[@]} -eq 0 ]; then
        # Controllers (e.g. the NVIDIA I2C adapters) can appear late during boot.
        echo "rgb-off: try $attempt: no devices detected" >&2
        continue
    fi
    found=("${devices[@]}")
    found_list="$list"
    read -ra args <<< "${devices[*]}"
    echo "rgb-off: try $attempt: openrgb ${args[*]}" >&2
    timeout -k 5 60 openrgb --noautoconnect "${args[@]}" && exit 0
    echo "rgb-off: try $attempt failed (exit $?)" >&2
done

if [ ${#found[@]} -eq 0 ]; then
    echo "rgb-off: OpenRGB found no RGB devices." >&2
    print_list "$list"
    exit 1
fi

echo "rgb-off: every combined call failed; turning devices off one at a time" >&2
failed=0
for spec in "${found[@]}"; do
    read -ra args <<< "$spec"
    echo "rgb-off: openrgb ${args[*]}" >&2
    if ! timeout -k 5 30 openrgb --noautoconnect "${args[@]}"; then
        failed=$((failed + 1))
    fi
done

if [ "$failed" -eq ${#found[@]} ]; then
    echo "rgb-off: no device could be turned off." >&2
    print_list "$found_list"
    exit 1
fi
if [ "$failed" -gt 0 ]; then
    echo "rgb-off: $failed of ${#found[@]} devices could not be turned off" >&2
fi
exit 0
