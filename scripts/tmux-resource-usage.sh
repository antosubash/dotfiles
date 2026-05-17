#!/bin/sh
# Resource summary for the tmux status bar:
# CPU%, MEM used/total, disk% on /, net rx/tx rate, temp, claude procs, uptime, load.

set -eu

state="${TMPDIR:-/tmp}/tmux-resource-usage.${USER:-$(id -u)}"

# /proc/stat fields: user nice system idle iowait irq softirq steal ...
read -r _ u n s i io irq sirq st _ < /proc/stat
cpu_total=$((u + n + s + i + io + irq + sirq + st))
cpu_idle=$((i + io))

# /proc/uptime also serves as a monotonic timestamp for the net rate.
read -r uptime_s _ < /proc/uptime
ut=${uptime_s%.*}

net=$(awk '$1 ~ /:$/ {
    iface = $1; sub(/:$/, "", iface)
    if (iface == "lo") next
    rx += $2; tx += $10
} END { printf "%d %d", rx+0, tx+0 }' /proc/net/dev)
rx_now=${net% *}
tx_now=${net#* }

prev_total=0; prev_idle=0; prev_rx=0; prev_tx=0; prev_ut=0
if [ -r "$state" ]; then
    read -r prev_total prev_idle prev_rx prev_tx prev_ut < "$state" || :
fi

diff_total=$((cpu_total - prev_total))
diff_idle=$((cpu_idle - prev_idle))
if [ "$diff_total" -gt 0 ]; then
    cpu=$(( (diff_total - diff_idle) * 100 / diff_total ))
else
    cpu=0
fi

dt=$((ut - prev_ut))
if [ "$dt" -gt 0 ]; then
    rx_rate=$(( (rx_now - prev_rx) / dt ))
    tx_rate=$(( (tx_now - prev_tx) / dt ))
else
    rx_rate=0; tx_rate=0
fi

printf '%s %s %s %s %s\n' "$cpu_total" "$cpu_idle" "$rx_now" "$tx_now" "$ut" > "$state"

disk=$(df -P / | awk 'NR==2 {sub(/%/,"",$5); print $5}')
mem=$(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "%.1f/%.1fG", (t-a)/1048576, t/1048576}' /proc/meminfo)
read -r load _ < /proc/loadavg

temp=""
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
    read -r t < /sys/class/thermal/thermal_zone0/temp
    temp=$((t / 1000))
fi

cc=$(pgrep -c claude 2>/dev/null || true)

days=$((ut / 86400))
if [ "$days" -gt 0 ]; then
    up_h="${days}d"
else
    up_h="$((ut / 3600))h"
fi

rates=$(awk -v rx="$rx_rate" -v tx="$tx_rate" '
function f(b) { return b < 1048576 ? sprintf("%dK", b/1024) : sprintf("%.1fM", b/1048576) }
BEGIN { printf "%s %s", f(rx), f(tx) }')
rx_s=${rates% *}
tx_s=${rates#* }

out=$(printf 'CPU %d%% MEM %s / %d%% ↓%s↑%s' "$cpu" "$mem" "$disk" "$rx_s" "$tx_s")
[ -n "$temp" ] && out="$out T ${temp}°"
out="$out L $load"
[ "$cc" -gt 0 ] && out="$out cc:${cc}"
out="$out up $up_h"
printf '%s' "$out"
