"""Ori Mnemos lifecycle hooks for Hermes Agent.

on_pre_llm_call:  injects the Ori session briefing into the first turn of a
                  session (deterministic `ori wake` — no reliance on the model
                  choosing to call ori_wake/ori_orient). wake is the bounded
                  boot path: its budget is a hard line cap, so the briefing is
                  constant-size no matter how large the vault grows.
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


def _ori_env(vault):
    """Env for an `ori` subprocess, pinning the vault.

    `ORI_VAULT` is ori's own authoritative override (validated, and it throws
    rather than silently walking up to some parent vault). The gateway does not
    export it — only the MCP subprocess gets it — so every spawn has to set it,
    otherwise `ori` resolves against the gateway's cwd instead of the profile.
    """
    env = dict(os.environ)
    env["ORI_VAULT"] = vault
    return env


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


# `ori wake` returns a FLAT line list plus per-section counts. The counts are
# what turn the flat list back into labelled prose.
#
# We iterate the counts mapping in ITS OWN order rather than a fixed list here:
# buildWakePayload emits sectionMap in emission order and JSON preserves it, so
# following it means an upstream insertion or rename shifts nothing. A hardcoded
# order would slip the cursor and mislabel every later section — silently, with
# no conflict and no error. Unknown names get a derived heading.
_WAKE_HEADINGS = {
    "identity_line": None,              # folded into the preamble, not a heading
    "active_goals": "Active goals",
    "reminders_due": "Reminders due",
    "daily_recent": "Recent activity",
    "warm_notes": "Active in memory",
    "resurfaced": "Resurfaced",
    "vault_vitals": "Vault",
    "notices": "Notices",
}

_PREAMBLE = (
    "[Ori session briefing — auto-loaded at session start. You have persistent "
    "memory via the `ori` tools; do not start cold. Search with ori_query_ranked "
    "before creating notes, and reuse the absolute path ori_add returns when you "
    "call ori_validate/ori_promote.]"
)


def _demote(line):
    """Re-level a heading lifted verbatim out of a vault file.

    `head` mode on a day-state file pulls its own `# Daily State` along, and an
    H1 nested under our `## Recent activity` inverts the outline it sits in.
    """
    stripped = line.lstrip()
    if stripped.startswith("#"):
        return "### " + stripped.lstrip("#").strip()
    return line


def _is_heading(line):
    return line.lstrip().startswith("#")


def _prune_empty_headings(chunk):
    """Drop headings that have nothing under them.

    A skeleton day file (`## Completed Today` / `## Pending Today` with no
    entries yet) otherwise contributes only headings — pure noise that still
    spends lines of a hard budget.
    """
    kept = []
    for i, line in enumerate(chunk):
        if not _is_heading(line):
            kept.append(line)
            continue
        if any(not _is_heading(nxt) for nxt in chunk[i + 1:i + 2]):
            kept.append(line)
    return kept


def _format_briefing(data):
    """Render a `ori wake --json` payload as a compact markdown block.

    `data` is ``{lines: [...], sections: {name: count}}``. Walking the sections
    in their fixed emission order and slicing `lines` by the counts recovers the
    structure the flat list threw away — without it the model gets an unlabelled
    wall of text where a goal and a vault stat look identical.
    """
    lines = data.get("lines") or []
    counts = data.get("sections") or {}

    parts = [_PREAMBLE]
    cursor = 0
    for name, count in counts.items():
        if not isinstance(count, int) or count <= 0:
            continue
        heading = _WAKE_HEADINGS.get(name, name.replace("_", " ").capitalize())
        chunk = [l for l in lines[cursor:cursor + count] if l and l.strip()]
        cursor += count
        if heading is None:
            if chunk:
                parts.append(" ".join(chunk))
            continue
        chunk = _prune_empty_headings(chunk)
        if not chunk:
            continue
        parts.append(f"## {heading}\n" + "\n".join(_demote(l) for l in chunk))

    # Only the preamble means the vault produced nothing worth injecting.
    if len(parts) <= 1:
        return ""
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
            [_resolve_ori_bin(), "wake", "--json", "--budget", "96"],
            capture_output=True,
            text=True,
            env=_ori_env(vault),
            # Never inherit fd 0. Under the TUI, the gateway's stdin is an
            # AF_UNIX socketpair to the TUI parent, and `ori` sets O_NONBLOCK
            # on whichever stdio fd is a socket (~0.14s after spawn, restored
            # ~0.4s later on exit). O_NONBLOCK lives on the shared open file
            # description, so that flag lands on the gateway's own stdin: any
            # read entering that window gets EAGAIN, which CPython's buffered
            # layer launders into a clean '' — the read loop falls through and
            # the gateway exits 0 with a bogus "stdin EOF (TUI closed the
            # command pipe)". capture_output already gives fresh pipes for
            # stdout/stderr; stdin was the hole.
            stdin=subprocess.DEVNULL,
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
    vault = _resolve_vault()
    if not vault:
        return

    try:
        result = subprocess.run(
            [_resolve_ori_bin(), "health"],
            capture_output=True,
            text=True,
            env=_ori_env(vault),
            # see on_pre_llm_call(): inherited fd 0 kills the TUI gateway
            stdin=subprocess.DEVNULL,
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
    vault = _resolve_vault()
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
            [_resolve_ori_bin(), "add", title, "--type", "insight"],
            env=_ori_env(vault),
            # This call inherited ALL THREE stdio fds. Under the TUI that means
            # fd 0 AND fd 1 are the gateway's socketpairs to its parent: fd 0
            # gets O_NONBLOCK'd into a spurious "stdin EOF" (see
            # on_pre_llm_call()), and fd 1 is the JSON-RPC channel — ori's own
            # stdout lands in the protocol stream, and gateway writes during the
            # window raise BlockingIOError, which transport.py re-raises (EAGAIN
            # is not a peer-gone errno). Redirect all three.
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
