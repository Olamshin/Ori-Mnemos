"""Ori Mnemos lifecycle hooks for Hermes Agent.

on_pre_llm_call:  injects the Ori session briefing into the first turn of a
                  session (deterministic orient — no reliance on the model
                  choosing to call ori_orient).
on_session_start: prints vault health summary (note count, inbox, fading, orphans).
on_session_end:   captures a session insight via `ori add`.

All hooks silently no-op if no vault is found.
"""

import json
import os
import shutil
import subprocess

# Sessions we've already oriented (belt-and-suspenders on top of is_first_turn).
# The gateway process is long-lived, so this persists across turns within a run.
_oriented_sessions = set()


def _resolve_vault():
    """Resolve the vault root for the active profile.

    Order: ORI_VAULT env > $HERMES_HOME/brain (the per-profile vault the
    gateway runs against) > a brain/ next to this plugin > walk up from cwd.
    Returns None if nothing with a .ori directory is found.
    """
    candidates = []
    env_vault = os.environ.get("ORI_VAULT")
    if env_vault:
        candidates.append(env_vault)
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        candidates.append(os.path.join(hermes_home, "brain"))
    # plugins/ori/hooks.py -> <profile>/brain
    profile_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    candidates.append(os.path.join(profile_dir, "brain"))

    for cand in candidates:
        if cand and os.path.isdir(os.path.join(cand, ".ori")):
            return cand
    return _find_vault()


def _resolve_ori_bin():
    """Find the `ori` binary. The gateway PATH does not include the overlay
    install, so prefer the absolute path derived from HERMES_HOME, then PATH."""
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        # HERMES_HOME = ~/.hermes/profiles/<p>  ->  ~/.hermes/node/bin/ori
        hermes_root = os.path.dirname(os.path.dirname(hermes_home))
        overlay = os.path.join(hermes_root, "node", "bin", "ori")
        if os.path.exists(overlay):
            return overlay
    return shutil.which("ori") or "ori"


def _strip_frontmatter(text):
    """Drop a leading YAML frontmatter block so the briefing reads cleanly."""
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def _section(title, body, limit=1800):
    body = _strip_frontmatter(body or "").strip()
    if not body:
        return ""
    if len(body) > limit:
        body = body[:limit].rstrip() + "\n…(truncated)"
    return f"## {title}\n{body}"


def _format_briefing(data):
    """Render the orient payload as a compact markdown block for injection."""
    parts = [
        "[Ori session briefing — auto-loaded at session start. You have persistent "
        "memory via the `ori` tools; do not start cold. Search with ori_query_ranked "
        "before creating notes, and reuse the absolute path ori_add returns when you "
        "call ori_validate/ori_promote.]"
    ]

    if data.get("firstRun"):
        parts.append(
            "## New vault\nThis vault has no identity yet — run onboarding (ask the user "
            "to name the agent, its purpose, and do a brain dump), then save with ori_update."
        )

    for title, key in (
        ("Today (ops/daily.md)", "daily"),
        ("Reminders (ops/reminders.md)", "reminders"),
        ("Active goals (self/goals.md)", "goals"),
    ):
        section = _section(title, data.get(key))
        if section:
            parts.append(section)

    vs = data.get("vaultStatus") or {}
    ih = data.get("indexHealth") or {}
    bits = []
    if vs:
        bits.append(f"{vs.get('noteCount', 0)} notes")
        if vs.get("inboxCount"):
            bits.append(f"{vs['inboxCount']} in inbox")
        if vs.get("orphanCount"):
            bits.append(f"{vs['orphanCount']} orphan(s)")
    if ih:
        bits.append(f"index {ih.get('coveragePercent', '?')}%")
        if ih.get("stale"):
            bits.append(f"{ih['stale']} stale")
    if bits:
        line = "## Vault\n" + " · ".join(bits)
        if ih.get("warning"):
            line += f"\n⚠ {ih['warning']}"
        parts.append(line)

    heating = (data.get("warmthLandscape") or {}).get("heating") or []
    if heating:
        parts.append("## Active in memory\n" + ", ".join(heating[:8]))

    return "\n\n".join(p.strip() for p in parts if p and p.strip())


def on_pre_llm_call(**kwargs):
    """Inject the Ori session briefing on the first turn of a session.

    Returns ``{"context": ...}`` which Hermes appends to the user message
    (ephemeral, never persisted). No-ops on continuation turns and on any
    failure, so a broken vault or missing binary never blocks a turn.
    """
    if not kwargs.get("is_first_turn"):
        return None

    session_id = kwargs.get("session_id") or ""
    if session_id and session_id in _oriented_sessions:
        return None

    vault = _resolve_vault()
    if not vault:
        return None

    try:
        result = subprocess.run(
            [_resolve_ori_bin(), "orient", "--vault", vault],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if result.returncode != 0:
            return None
        payload = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError, OSError):
        return None

    data = payload.get("data", payload)
    briefing = _format_briefing(data)
    if not briefing:
        return None

    if session_id:
        _oriented_sessions.add(session_id)
    return {"context": briefing}


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
