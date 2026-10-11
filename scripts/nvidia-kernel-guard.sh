#!/bin/bash

# Make sure the newest installed kernel has an NVIDIA kernel module.
#
# Ubuntu ships the NVIDIA driver as precompiled linux-modules-nvidia-* packages,
# one per kernel. When a new kernel arrives together with a new NVIDIA driver,
# the module package for the new kernel can only be installed by removing the
# one built for the old kernel. `apt upgrade` never removes packages, so it
# installs the new kernel but holds the NVIDIA module back, and the next boot
# has no graphics driver. Use `apt full-upgrade`, and run this afterwards.
#
# Usage: nvidia-kernel-guard.sh [-q] [--fix]
#   -q     print nothing when everything is fine (for the APT hook)
#   --fix  install the missing module package with apt (needs sudo)
#
# Exit 0 when the module is present or the Ubuntu NVIDIA driver isn't installed;
# exit 1 when the newest kernel has no NVIDIA module.

set -u

BOOT_DIR="${NVIDIA_GUARD_BOOT_DIR:-/boot}"
MODULES_DIR="${NVIDIA_GUARD_MODULES_DIR:-/lib/modules}"

newest_kernel() {
    local f
    for f in "$BOOT_DIR"/vmlinuz-*; do
        [ -e "$f" ] && printf '%s\n' "${f##*/vmlinuz-}"
    done | sort -V | tail -n 1
}

# Installed driver package, e.g. nvidia-driver-595-open
driver_package() {
    dpkg-query -W -f='${Status} ${Package}\n' 'nvidia-driver-[0-9]*' 2>/dev/null |
        awk '$1 == "install" && $3 == "installed" { print $4; exit }'
}

has_module() {
    [ -n "$(find "$MODULES_DIR/$1" -name 'nvidia.ko*' -print -quit 2>/dev/null)" ]
}

warn() {
    printf '\033[1;31m%s\033[0m\n' "$*" >&2
}

main() {
    local quiet=false fix=false arg
    for arg in "$@"; do
        case "$arg" in
            -q) quiet=true ;;
            --fix) fix=true ;;
            *) echo "Usage: $0 [-q] [--fix]" >&2; return 2 ;;
        esac
    done

    local driver kernel module_pkg
    driver="$(driver_package)"
    kernel="$(newest_kernel)"
    [ -n "$driver" ] && [ -n "$kernel" ] || return 0

    if has_module "$kernel"; then
        [ "$quiet" = true ] || echo "✓ NVIDIA module present for kernel $kernel"
        return 0
    fi

    # nvidia-driver-595-open -> linux-modules-nvidia-595-open-7.0.0-38-generic
    module_pkg="linux-modules-nvidia-${driver#nvidia-driver-}-$kernel"

    if [ "$fix" = true ] && apt-cache show "$module_pkg" > /dev/null 2>&1; then
        echo "Installing $module_pkg for kernel $kernel..."
        if sudo apt-get install -y "$module_pkg" && has_module "$kernel"; then
            echo "✓ NVIDIA module installed for kernel $kernel"
            return 0
        fi
    fi

    warn "✗ Kernel $kernel has no NVIDIA module ($driver is installed)."
    warn "  Rebooting now would start without the graphics driver."
    if apt-cache show "$module_pkg" > /dev/null 2>&1; then
        warn "  Fix: sudo apt full-upgrade   (or: sudo apt install $module_pkg)"
    else
        warn "  $module_pkg isn't published yet. Wait for it, or pick the"
        warn "  previous kernel under 'Advanced options' in GRUB until it is."
    fi
    command -v logger > /dev/null && logger -t nvidia-kernel-guard "kernel $kernel has no NVIDIA module ($module_pkg missing)"
    return 1
}

main "$@"
