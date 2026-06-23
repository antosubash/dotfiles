#!/usr/bin/env python3
"""Claude Code status line.

Shows: model · context-window bar · 5-hour limit (+reset) · weekly limit (+reset).

- Context %: prefers `context_window.used_percentage`; falls back to computing the
  current fill from the session transcript (latest assistant turn).
- 5h / weekly: from the `rate_limits` field —
    rate_limits.five_hour / .seven_day, each {used_percentage, resets_at}
  where resets_at is a Unix timestamp (seconds). Reset is rendered as a countdown.
"""
import sys, json, os, time

CYAN = "\033[0;36m"; DIM = "\033[2m"; RST = "\033[0m"
GREEN = "\033[0;32m"; YELLOW = "\033[0;33m"; RED = "\033[0;31m"
SEP = f" {DIM}·{RST} "


def color(pct):
    return RED if pct >= 90 else YELLOW if pct >= 70 else GREEN


def ctx_of(x):
    return (x.get("input_tokens", 0)
            + x.get("cache_read_input_tokens", 0)
            + x.get("cache_creation_input_tokens", 0))


def from_transcript(path, exceeds_200k):
    if not path or not os.path.exists(path):
        return None, None
    last_ctx = peak_ctx = 0
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") != "assistant":
                    continue
                u = ((d.get("message") or {}).get("usage")) or {}
                iters = u.get("iterations") or [u]
                c = max((ctx_of(it) for it in iters), default=0)
                if c:
                    last_ctx = c
                    peak_ctx = max(peak_ctx, c)
    except OSError:
        return None, None
    if not last_ctx:
        return None, None
    window = 1_000_000 if (peak_ctx > 200_000 or exceeds_200k) else 200_000
    return last_ctx, window


def context_pct(data):
    cw = data.get("context_window")
    if isinstance(cw, dict) and cw.get("used_percentage") is not None:
        try:
            return float(cw["used_percentage"])
        except (TypeError, ValueError):
            pass
    tokens, window = from_transcript(
        data.get("transcript_path"), bool(data.get("exceeds_200k_tokens")))
    return tokens / window * 100 if tokens is not None else None


def _window(obj):
    """Return (used_percentage, resets_at) from a rate-limit window entry."""
    if isinstance(obj, dict):
        pct = None
        for k in ("used_percentage", "usedPercentage", "percent", "utilization"):
            if obj.get(k) is not None:
                try:
                    pct = float(obj[k]); break
                except (TypeError, ValueError):
                    pass
        reset = obj.get("resets_at") or obj.get("resetsAt") or obj.get("reset_at")
        return pct, reset
    if isinstance(obj, (int, float)):
        return float(obj), None
    return None, None


def rate_limits(data):
    """Return (five_hour, weekly), each a (pct, resets_at) tuple."""
    rl = data.get("rate_limits") or data.get("rateLimits")
    five = weekly = (None, None)
    if isinstance(rl, dict):
        for k, v in rl.items():
            kl = str(k).lower().replace("_", "").replace("-", "")
            if any(t in kl for t in ("5h", "fivehour", "5hour")):
                five = _window(v)
            elif any(t in kl for t in ("7d", "sevenday", "weekly", "week")):
                weekly = _window(v)
    elif isinstance(rl, list):
        for v in rl:
            name = ""
            if isinstance(v, dict):
                name = (str(v.get("type", "")) + str(v.get("window", ""))
                        + str(v.get("name", ""))).lower()
            if any(t in name for t in ("5", "five", "hour")):
                five = _window(v)
            elif any(t in name for t in ("7", "seven", "week")):
                weekly = _window(v)
    return five, weekly


def countdown(ts):
    """Format seconds-until-reset as a compact countdown, e.g. 4h12m, 2d3h, 7m."""
    if not ts:
        return None
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return None
    if ts > 1e12:        # tolerate millisecond timestamps
        ts /= 1000.0
    rem = int(ts - time.time())
    if rem <= 0:
        return "now"
    d, rem = divmod(rem, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m}m"
    return f"{m}m"


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        data = {}

    parts = [f"{CYAN}{(data.get('model') or {}).get('display_name') or 'Claude'}{RST}"]

    pct = context_pct(data)
    if pct is not None:
        pct = max(0.0, min(100.0, pct))
        col = color(pct)
        width = 10
        filled = int(round(pct / 100 * width))
        bar = "█" * filled + "░" * (width - filled)
        parts.append(f"{DIM}[{RST}{col}{bar}{RST}{DIM}]{RST} {col}{pct:.0f}%{RST}")

    five, weekly = rate_limits(data)
    for label, (wpct, reset) in (("5h", five), ("wk", weekly)):
        if wpct is None:
            continue
        seg = f"{DIM}{label}{RST} {color(wpct)}{wpct:.0f}%{RST}"
        cd = countdown(reset)
        if cd:
            seg += f" {DIM}({cd}){RST}"
        parts.append(seg)

    sys.stdout.write(SEP.join(parts))


if __name__ == "__main__":
    main()
