#!/usr/bin/env python3
"""iTerm2 AutoLaunch bridge for pi-session-deck tmux opens.

Install by symlinking or copying this file into iTerm2's Scripts/AutoLaunch
folder. The TypeScript side talks to a user-local Unix socket using JSON-lines:

  {"tmuxAttachArgv":["tmux","-S","...","attach-session","-E","-t","..."]}\n
Only exact tmux attach argv arrays are accepted.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import signal
import tempfile
from pathlib import Path
from typing import Any, Optional

import iterm2

SOCKET_ENV = "PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET"
REQUEST_TIMEOUT_SECONDS = 2.0
INVALID_ATTACH_ARGV_MESSAGE = (
    "Bridge only accepts exact tmux attach argv in 'tmuxAttachArgv'."
)


def default_socket_path() -> Path:
    configured = os.environ.get(SOCKET_ENV)
    if configured:
        return Path(configured).expanduser()

    uid = os.getuid() if hasattr(os, "getuid") else "user"
    return Path(tempfile.gettempdir()) / f"pi-session-deck-{uid}" / "iterm2-python-bridge.sock"


def prepare_socket_path(path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    try:
        path.unlink()
    except FileNotFoundError:
        pass


def response(ok: bool, **fields: Any) -> bytes:
    return (json.dumps({"ok": ok, **fields}, separators=(",", ":")) + "\n").encode("utf-8")


def validate_tmux_attach_argv(candidate: Any) -> Optional[list[str]]:
    if not isinstance(candidate, list) or len(candidate) != 7:
        return None
    if any(not isinstance(arg, str) or len(arg.strip()) == 0 for arg in candidate):
        return None

    program, selector_flag, selector, subcommand, preserve_env, target_flag, _target = candidate
    if (
        program != "tmux"
        or selector_flag not in ("-S", "-L")
        or subcommand != "attach-session"
        or preserve_env != "-E"
        or target_flag != "-t"
    ):
        return None
    if selector_flag == "-L" and "/" in selector:
        return None

    return list(candidate)


def format_iterm2_shell_command(tmux_attach_argv: list[str]) -> str:
    return "exec " + " ".join(shlex.quote(arg) for arg in tmux_attach_argv)


async def open_iterm2_tab(connection: iterm2.Connection, tmux_attach_argv: list[str]) -> None:
    command = format_iterm2_shell_command(tmux_attach_argv)
    app = await iterm2.async_get_app(connection)
    window = app.current_terminal_window

    if window is None:
        window = await iterm2.Window.async_create(connection, command=command)
        tab = window.current_tab
    else:
        tab = await window.async_create_tab(command=command)

    for action in (
        getattr(app, "async_activate", None),
        getattr(window, "async_activate", None),
        getattr(tab, "async_select", None),
    ):
        if action is None:
            continue
        try:
            await action()
        except Exception:
            pass


async def handle_client(
    connection: iterm2.Connection,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=REQUEST_TIMEOUT_SECONDS)
        request = json.loads(line.decode("utf-8"))
        tmux_attach_argv = (
            validate_tmux_attach_argv(request.get("tmuxAttachArgv"))
            if isinstance(request, dict)
            else None
        )
        if tmux_attach_argv is None:
            writer.write(
                response(
                    False,
                    reason="open-failed",
                    message=INVALID_ATTACH_ARGV_MESSAGE,
                )
            )
            await writer.drain()
            return

        await open_iterm2_tab(connection, tmux_attach_argv)
        writer.write(response(True))
        await writer.drain()
    except asyncio.TimeoutError:
        writer.write(
            response(False, reason="open-failed", message="Bridge request timed out.")
        )
        await writer.drain()
    except json.JSONDecodeError as error:
        writer.write(
            response(False, reason="open-failed", message=f"Malformed JSON request: {error}")
        )
        await writer.drain()
    except Exception as error:  # iTerm2 API failures should be reported, not crash the daemon.
        writer.write(
            response(False, reason="open-failed", message=f"Failed to create iTerm2 tab: {error}")
        )
        await writer.drain()
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def main(connection: iterm2.Connection) -> None:
    socket_path = default_socket_path()
    prepare_socket_path(socket_path)

    server = None

    def cleanup() -> None:
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass

    try:
        server = await asyncio.start_unix_server(
            lambda reader, writer: handle_client(connection, reader, writer),
            path=str(socket_path),
        )

        loop = asyncio.get_running_loop()
        shutdown_requested = asyncio.Event()

        def request_shutdown() -> None:
            loop.call_soon_threadsafe(shutdown_requested.set)

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, request_shutdown)
            except (NotImplementedError, RuntimeError):
                pass

        await shutdown_requested.wait()
    finally:
        if server is not None:
            server.close()
            await server.wait_closed()
        cleanup()


iterm2.run_forever(main)
