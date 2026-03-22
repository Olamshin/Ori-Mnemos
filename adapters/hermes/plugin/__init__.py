"""Ori Mnemos plugin for Hermes Agent.

Registers lifecycle hooks for automatic session orient and capture.
Requires the `ori` CLI to be installed and available on PATH.
"""

from .hooks import on_session_start, on_session_end


def register(ctx):
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_end", on_session_end)
