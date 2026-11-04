#!/usr/bin/env python3
"""Benchmark charts for the README, the demo video and the submission (ADR-008: Python for charts only).

Reads `bench/results/results.json` (written by `pnpm bench`) and `bench/model-runs.json` (summaries of
runs with the real model; no transcripts, no keys) and writes SVG charts to `docs/media/`, each in a
light and a dark version. Standard library only, so nothing needs installing:

    pnpm bench && python3 bench/charts/make_charts.py

Charts:
  bench-headline   attacks blocked by setup, out of all attacks (the published, scripted run)
  bench-families   per attack family: limits only vs Warrant
  bench-layers     which Warrant layer stopped each blocked attack
  bench-model      share of attacks blocked: scripted agent vs the real model, by setup
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "bench" / "results" / "results.json"
MODEL_RUNS = ROOT / "bench" / "model-runs.json"
OUT = ROOT / "docs" / "media"

# Colours: the validated reference palette (categorical slots 1 and 2 pass every check together),
# chrome and ink by role. Warrant is always slot 1; the comparison bar is a recessive neutral.
THEMES = {
    "light": {
        "surface": "#fcfcfb", "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781",
        "grid": "#e1e0d9", "axis": "#c3c2b7", "s1": "#2a78d6", "s2": "#eb6834", "neutral": "#b9b7af",
    },
    "dark": {
        "surface": "#1a1a19", "ink": "#f0efec", "ink2": "#c3c2b7", "muted": "#898781",
        "grid": "#2c2c2a", "axis": "#383835", "s1": "#3987e5", "s2": "#d95926", "neutral": "#5d5c57",
    },
}
FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
W = 960
PAD_X = 40

MODES = ("unprotected", "limits_only", "warrant")
MODE_NAMES = {"unprotected": "No protection", "limits_only": "Limits only", "warrant": "Warrant"}
LAYER_NAMES = {
    "rules": "Rules in code",
    "owner": "Waited for the owner",
    "purpose": "Purpose check",
    "rail": "Refused at the rail",
}


FAMILY_NAMES = {
    "budget_drain": "Budget drain",
    "duplicate_charge": "Duplicate charge",
    "fake_invoice": "Fake invoice",
    "fake_price_notice": "Fake price notice",
    "fx_rate_manipulation": "FX rate manipulation",
    "hidden_instruction_invoice": "Hidden instructions in an invoice",
    "payee_swap": "Payee swap",
    "price_rise": "Price rise",
    "prompt_injection": "Prompt injection",
    "refund_fraud": "Refund fraud",
    "sneaky_recurring": "Sneaky recurring charge",
    "subscription_trap": "Subscription trap",
    "swapped_payee": "Swapped payee",
    "urgent_refund_social": "Urgent refund (social engineering)",
}


def family_name(f: str) -> str:
    return FAMILY_NAMES.get(f, f.replace("_", " ").capitalize())


def bar(x: float, y: float, w: float, h: float, fill: str) -> str:
    """A horizontal bar anchored at the baseline, with a 4px rounded data end."""
    if w <= 0:
        return ""
    r = min(4.0, w / 2, h / 2)
    return (
        f'<path d="M{x:.1f},{y:.1f} H{x + w - r:.1f} Q{x + w:.1f},{y:.1f} {x + w:.1f},{y + r:.1f} '
        f'V{y + h - r:.1f} Q{x + w:.1f},{y + h:.1f} {x + w - r:.1f},{y + h:.1f} H{x:.1f} Z" fill="{fill}"/>'
    )


def text(x: float, y: float, s: str, *, size: int, fill: str, weight: int = 400, anchor: str = "start") -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
        f'text-anchor="{anchor}" dominant-baseline="middle">{escape(s)}</text>'
    )


def svg(height: float, body: list[str], t: dict[str, str], title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {height:.0f}" width="{W}" '
        f'height="{height:.0f}" role="img" aria-label="{escape(title)}" font-family=\'{FONT}\'>\n'
        f'<title>{escape(title)}</title>\n'
        f'<rect width="{W}" height="{height:.0f}" fill="{t["surface"]}"/>\n' + "\n".join(b for b in body if b) + "\n</svg>\n"
    )


def header(t: dict[str, str], title: str, subtitle: str) -> list[str]:
    return [
        text(PAD_X, 40, title, size=26, fill=t["ink"], weight=700),
        text(PAD_X, 74, subtitle, size=16, fill=t["ink2"]),
    ]


def footer(t: dict[str, str], y: float, note: str) -> str:
    return text(PAD_X, y, note, size=13, fill=t["muted"])


def legend(t: dict[str, str], y: float, items: list[tuple[str, str]]) -> list[str]:
    out, x = [], PAD_X
    for label, colour in items:
        out.append(f'<rect x="{x}" y="{y - 7}" width="14" height="14" rx="3" fill="{colour}"/>')
        out.append(text(x + 22, y, label, size=15, fill=t["ink2"]))
        x += 22 + 9 * len(label) + 34
    return out


# --- data -------------------------------------------------------------------------------------


def load() -> tuple[dict, list[dict]]:
    if not RESULTS.exists():
        sys.exit(f"{RESULTS} not found: run `pnpm bench` first")
    r = json.loads(RESULTS.read_text())
    if r.get("agent") != "scripted-naive":
        sys.exit("results.json is not the scripted run: run `pnpm bench` without BENCH_AGENT=model")
    runs = json.loads(MODEL_RUNS.read_text())["runs"] if MODEL_RUNS.exists() else []
    return r, runs


def scores(r: dict) -> dict[str, dict]:
    return {s["mode"]: s for s in r["scores"]}


# --- charts -----------------------------------------------------------------------------------


def headline(r: dict, t: dict[str, str]) -> tuple[str, str]:
    s = scores(r)
    attacks = s["warrant"]["attacks"]
    benign = s["warrant"]["benign"]
    title = f"Attacks blocked, out of {attacks}"
    body = header(t, title, "The same agent and the same attacks, with three levels of protection")
    label_w, plot_x0 = 170, PAD_X + 170
    plot_w = W - plot_x0 - 190
    y0, row = 118, 58
    for i, m in enumerate(MODES):
        blocked = s[m]["attacks"] - s[m]["misses"]
        y = y0 + i * row
        w = plot_w * blocked / attacks
        colour = t["s1"] if m == "warrant" else t["neutral"]
        body.append(text(PAD_X, y + 16, MODE_NAMES[m], size=18, fill=t["ink"], weight=700 if m == "warrant" else 400))
        body.append(f'<rect x="{plot_x0}" y="{y}" width="{plot_w}" height="32" rx="4" fill="{t["grid"]}" opacity="0.6"/>')
        body.append(bar(plot_x0, y, w, 32, colour))
        pct = 100 * blocked / attacks
        body.append(text(plot_x0 + plot_w + 14, y + 16, f"{blocked}  ({pct:.0f}%)", size=18, fill=t["ink"], weight=700 if m == "warrant" else 400))
    held = " · ".join(f"{MODE_NAMES[m]} {s[m]['falseBlocks']}" for m in MODES)
    yb = y0 + 3 * row + 10
    body.append(text(PAD_X, yb, f"Normal payments wrongly held, out of {benign}:  {held}", size=15, fill=t["ink2"]))
    held_out = {x["mode"]: x for x in r.get("heldout") or []}
    if "warrant" in held_out:
        h = held_out["warrant"]
        body.append(text(PAD_X, yb + 26, f"Held-out attacks written by someone who didn't build control: {h['attacks'] - h['misses']} of {h['attacks']} blocked by Warrant", size=15, fill=t["ink2"]))
    body.append(footer(t, yb + 62, "Scripted agent that obeys instructions hidden in the text, deterministic purpose check. Source: pnpm bench."))
    return svg(yb + 84, body, t, title), title


def families(r: dict, t: dict[str, str]) -> tuple[str, str]:
    s = scores(r)
    fams = [f for f in s["warrant"]["byFamily"] if f != "benign"]

    def blocked(mode: str, f: str) -> tuple[int, int]:
        v = s[mode]["byFamily"][f]
        return v["cases"] - v["misses"], v["cases"]

    fams.sort(key=lambda f: (blocked("warrant", f)[0] - blocked("limits_only", f)[0], f), reverse=True)
    title = "Where Warrant adds to spending limits"
    body = header(t, title, "Attacks blocked per family: limits only vs the full Warrant")
    body += legend(t, 108, [("Limits only", t["neutral"]), ("Warrant", t["s1"])])
    label_w = 290
    plot_x0 = PAD_X + label_w
    plot_w = W - plot_x0 - 140
    y0, row, bh = 136, 40, 13
    most = max(blocked("warrant", f)[1] for f in fams)
    for i, f in enumerate(fams):
        y = y0 + i * row
        if i % 2 == 0:
            body.append(f'<rect x="{PAD_X - 8}" y="{y - 4}" width="{W - 2 * PAD_X + 16}" height="{row}" fill="{t["grid"]}" opacity="0.35"/>')
        lb, n = blocked("limits_only", f)
        wb, _ = blocked("warrant", f)
        body.append(text(PAD_X, y + bh + 1, family_name(f), size=15, fill=t["ink"]))
        body.append(bar(plot_x0, y, plot_w * lb / most, bh, t["neutral"]))
        body.append(bar(plot_x0, y + bh + 2, plot_w * wb / most, bh, t["s1"]))
        body.append(text(plot_x0 + plot_w + 12, y + bh + 1, f"{lb} → {wb} of {n}", size=14, fill=t["ink2"]))
    yb = y0 + len(fams) * row + 18
    body.append(footer(t, yb, "Sorted by how many more attacks Warrant blocks than limits alone. Scripted agent; source: pnpm bench."))
    return svg(yb + 22, body, t, title), title


def layers(r: dict, t: dict[str, str]) -> tuple[str, str]:
    c: Counter[str] = Counter()
    for x in r["cases"]:
        if x["mode"] == "warrant" and not x["benign"] and not x["heldout"] and x["verdict"] == "correct_block":
            sb = x["stoppedBy"]
            c[max(sb, key=sb.get) if sb else "none"] += 1
    total = sum(c.values())
    order = [k for k in ("rules", "owner", "purpose", "rail", "none") if c[k]]
    title = f"What stopped the {total} blocked attacks"
    rules_share = 100 * c["rules"] / total if total else 0
    body = header(
        t,
        title,
        f"The Warrant layer that stopped each attack: rules in code alone stop {rules_share:.0f}%, with no model or person asked",
    )
    plot_x0 = PAD_X + 230
    plot_w = W - plot_x0 - 150
    y0, row = 116, 50
    top = max(c.values())
    for i, k in enumerate(order):
        y = y0 + i * row
        body.append(text(PAD_X, y + 15, LAYER_NAMES.get(k, "Agent proposed nothing"), size=17, fill=t["ink"]))
        body.append(bar(plot_x0, y, plot_w * c[k] / top, 30, t["s1"]))
        body.append(text(plot_x0 + plot_w * c[k] / top + 12, y + 15, f"{c[k]}  ({100 * c[k] / total:.0f}%)", size=17, fill=t["ink"]))
    yb = y0 + len(order) * row + 16
    body.append(footer(t, yb, "Per attack, the layer that stopped most of its proposals. Scripted agent; source: pnpm bench."))
    return svg(yb + 22, body, t, title), title


def model(r: dict, runs: list[dict], t: dict[str, str]) -> tuple[str, str] | None:
    if not runs:
        return None
    m = runs[-1]
    s = scores(r)
    title = "A real model resists on its own; Warrant still adds"
    body = header(t, title, "Share of attacks blocked: scripted agent (obeys hidden text) vs the real model")
    body += legend(t, 108, [("Scripted agent", t["s2"]), (f"Real model ({m['agent']})", t["s1"])])
    plot_x0 = PAD_X + 170
    plot_w = W - plot_x0 - 110
    y0, row, bh = 140, 70, 22
    for i, mode in enumerate(MODES):
        y = y0 + i * row
        sc = s[mode]
        ps = (sc["attacks"] - sc["misses"]) / sc["attacks"]
        mm = m["modes"][mode]
        pm = mm["attacksBlocked"] / m["attacks"]
        body.append(text(PAD_X, y + bh, MODE_NAMES[mode], size=18, fill=t["ink"], weight=700 if mode == "warrant" else 400))
        body.append(bar(plot_x0, y, plot_w * ps, bh, t["s2"]))
        body.append(bar(plot_x0, y + bh + 3, plot_w * pm, bh, t["s1"]))
        body.append(text(plot_x0 + plot_w * ps + 10, y + bh / 2, f"{100 * ps:.0f}%", size=15, fill=t["ink2"]))
        body.append(text(plot_x0 + plot_w * pm + 10, y + bh + 3 + bh / 2, f"{100 * pm:.0f}%", size=15, fill=t["ink"], weight=700))
    yb = y0 + 3 * row + 8
    body.append(footer(t, yb, f"Scripted: {s['warrant']['attacks']} attacks, pnpm bench. Real model: {m['attacks']} attacks, run on {m['date']} ({m['note']})."))
    return svg(yb + 22, body, t, title), title


def main() -> None:
    r, runs = load()
    OUT.mkdir(parents=True, exist_ok=True)
    made = []
    for name, fn in (("headline", headline), ("families", families), ("layers", layers)):
        for theme, t in THEMES.items():
            doc, _ = fn(r, t)
            path = OUT / f"bench-{name}-{theme}.svg"
            path.write_text(doc)
            made.append(path)
    for theme, t in THEMES.items():
        out = model(r, runs, t)
        if out:
            path = OUT / f"bench-model-{theme}.svg"
            path.write_text(out[0])
            made.append(path)
    for p in made:
        print(p.relative_to(ROOT))


if __name__ == "__main__":
    main()
