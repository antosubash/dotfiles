#!/usr/bin/env python3
"""Report model + context usage for each Claude Code session.

Reads the JSONL transcripts under ~/.claude/projects and, for every session,
computes which model(s) were used and how full the context window got.

"Context used" for a single API turn = input_tokens + cache_read + cache_creation
(the total tokens fed to the model that turn). A session's peak of that value is
the high-water mark of how much context that session consumed.
"""
import json, os, sys, glob
from collections import Counter

ROOT = os.path.expanduser("~/.claude/projects")
# The 1M-context toggle is a session setting and is NOT encoded in the per-message
# model id (it's plain "claude-opus-4-8" either way). So infer the window from the
# observed peak: anything above the standard 200k window means 1M was enabled.
def window_for(peak: int) -> int:
    return 1_000_000 if peak > 200_000 else 200_000

def human(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}k"
    return str(n)

rows = []
for f in glob.glob(os.path.join(ROOT, "*", "*.jsonl")):
    project = os.path.basename(os.path.dirname(f))
    models = Counter()
    peak_ctx = 0
    out_tokens = 0
    turns = 0
    first_ts = last_ts = None
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = d.get("timestamp")
                if ts:
                    first_ts = first_ts or ts
                    last_ts = ts
                if d.get("type") != "assistant":
                    continue
                m = d.get("message", {})
                model = m.get("model")
                if model and model != "<synthetic>":
                    models[model] += 1
                u = m.get("usage", {}) or {}
                # A turn may have multiple internal iterations; the top-level usage
                # SUMS them, double-counting cached context. The real context-window
                # fill is the largest single iteration (or the turn itself if none).
                def ctx_of(x):
                    return (x.get("input_tokens", 0)
                            + x.get("cache_read_input_tokens", 0)
                            + x.get("cache_creation_input_tokens", 0))
                iters = u.get("iterations") or [u]
                peak_ctx = max([peak_ctx] + [ctx_of(it) for it in iters])
                out_tokens += u.get("output_tokens", 0)
                turns += 1
    except OSError:
        continue
    if turns == 0:
        continue
    win = window_for(peak_ctx)
    model_str = ", ".join(f"{mdl}({c})" for mdl, c in models.most_common()) or "?"
    rows.append({
        "session": os.path.basename(f)[:8],
        "project": project,
        "model": model_str,
        "peak_ctx": peak_ctx,
        "window": win,
        "pct": peak_ctx / win * 100 if win else 0,
        "out": out_tokens,
        "turns": turns,
        "last": (last_ts or "")[:19].replace("T", " "),
        "mtime": os.path.getmtime(f),
    })

rows.sort(key=lambda r: r["mtime"], reverse=True)

limit = int(sys.argv[1]) if len(sys.argv) > 1 else 25
print(f"{'last activity':<19}  {'project':<34}  {'sess':<8}  {'peak ctx':>9}  {'win%':>5}  {'out':>6}  {'turns':>5}  model")
print("-" * 140)
for r in rows[:limit]:
    proj = r["project"]
    if len(proj) > 34:
        proj = proj[:31] + "..."
    print(f"{r['last']:<19}  {proj:<34}  {r['session']:<8}  "
          f"{human(r['peak_ctx']):>9}  {r['pct']:>4.0f}%  {human(r['out']):>6}  "
          f"{r['turns']:>5}  {r['model']}")

print(f"\n{len(rows)} sessions total (showing {min(limit, len(rows))}). "
      f"Pass a number to show more, e.g. `python3 cc_sessions.py 100`.")
