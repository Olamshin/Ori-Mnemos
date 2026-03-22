"""Ori Mnemos lifecycle hooks for Hermes Agent.

on_session_start: prints vault health summary (note count, inbox, fading, orphans).
on_session_end:   captures a session insight via `ori add`.

Both hooks silently no-op if no vault is found.
"""

import json
import os
import subprocess


def _find_vault():
    """Resolve vault root: ORI_VAULT env > walk up from cwd looking for .ori directory."""
    vault = os.environ.get("ORI_VAULT")
    if vault and os.path.isdir(os.path.join(vault, ".ori")):
        return vault

    current = os.path.abspath(os.getcwd())
    while True:
        if os.path.isdir(os.path.join(current, ".ori")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def on_session_start(**kwargs):
    """Print vault health summary at session start."""
    vault = _find_vault()
    if not vault:
        return

    try:
        result = subprocess.run(
            ["ori", "health"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if result.returncode != 0:
            return

        data = json.loads(result.stdout)
        health = data.get("data", data)
        lines = [f"Vault: {health.get('noteCount', 0)} notes"]

        # Inbox
        inbox_dir = os.path.join(vault, "inbox")
        if os.path.isdir(inbox_dir):
            inbox_files = [f for f in os.listdir(inbox_dir) if f.endswith(".md")]
            if inbox_files:
                lines.append(f"Inbox: {len(inbox_files)} note(s) ready for promotion")
                for f in inbox_files[:5]:
                    lines.append(f"  - {f.rsplit('.md', 1)[0]}")
                if len(inbox_files) > 5:
                    lines.append(f"  ... and {len(inbox_files) - 5} more")

        # Fading notes
        fading = health.get("fading", [])
        if fading:
            lines.append(f"Fading: {len(fading)} note(s) losing vitality")
            for f in fading[:3]:
                vitality = f.get("vitality")
                vstr = f"{vitality:.2f}" if isinstance(vitality, (int, float)) else "?"
                lines.append(f"  - {f.get('note', '?')} (vitality: {vstr})")

        # Orphans / dangling
        orphans = health.get("orphanCount", 0)
        dangling = health.get("danglingCount", 0)
        if orphans > 0:
            lines.append(f"Orphans: {orphans}")
        if dangling > 0:
            lines.append(f"Dangling links: {dangling}")

        print("\n".join(lines))

    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        pass


def on_session_end(**kwargs):
    """Capture session summary as an inbox note via `ori add`."""
    vault = _find_vault()
    if not vault:
        return

    summary = ""
    for key in ("summary", "session_summary", "session_id"):
        val = kwargs.get(key)
        if isinstance(val, str) and val.strip():
            summary = val.strip()
            break

    if not summary:
        return

    title = " ".join(summary.split())[:120]

    try:
        subprocess.run(
            ["ori", "add", title, "--type", "insight"],
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
