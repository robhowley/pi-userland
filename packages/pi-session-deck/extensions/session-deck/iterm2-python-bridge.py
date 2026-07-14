#!/usr/bin/env python3
"""iTerm2 AutoLaunch bridge for pi-session-deck terminal focus.

Install by symlinking or copying this file into iTerm2's Scripts/AutoLaunch
folder. The TypeScript side talks to a user-local Unix socket using JSON-lines:

  {"tmuxAttachArgv":["tmux","-S","...","attach-session","-E","-t","..."]}\n
or:

  {"itermSessionId":"w0t0p0:..."}\n
Only exact tmux attach argv arrays and non-empty iTerm2 session ids are accepted.
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
INVALID_ITERM_SESSION_ID_MESSAGE = (
    "Bridge only accepts non-empty iTerm2 session ids in 'itermSessionId'."
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


def validate_iterm_session_id(candidate: Any) -> Optional[str]:
    if not isinstance(candidate, str):
        return None

    session_id = candidate.strip()
    return session_id if session_id else None


async def maybe_call(action: Any) -> None:
    if action is None:
        return
    await action()


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


async def focus_iterm2_session(connection: iterm2.Connection, iterm_session_id: str) -> bool:
    app = await iterm2.async_get_app(connection)
    get_session_by_id = getattr(app, "get_session_by_id", None)
    if get_session_by_id is None:
        raise RuntimeError("iTerm2 Python API does not expose get_session_by_id")

    candidate_ids = [iterm_session_id]
    if ":" in iterm_session_id:
        candidate_ids.append(iterm_session_id.rsplit(":", 1)[1])

    session = None
    for candidate_id in candidate_ids:
        try:
            session = get_session_by_id(candidate_id)
        except Exception:
            session = None
        if session is not None:
            break

    if session is None:
        return False

    tab = getattr(session, "tab", None)
    window = getattr(tab, "window", None) if tab is not None else None

    for action in (
        getattr(app, "async_activate", None),
        getattr(window, "async_activate", None),
        getattr(tab, "async_select", None),
    ):
        try:
            await maybe_call(action)
        except Exception:
            pass

    activate_session = getattr(session, "async_activate", None)
    if activate_session is None:
        raise RuntimeError("iTerm2 Python API does not expose Session.async_activate")
    await activate_session()
    return True


async def handle_client(
    connection: iterm2.Connection,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=REQUEST_TIMEOUT_SECONDS)
        request = json.loads(line.decode("utf-8"))
        if not isinstance(request, dict):
            writer.write(
                response(False, reason="open-failed", message="Bridge request must be an object.")
            )
            await writer.drain()
            return

        tmux_attach_argv = validate_tmux_attach_argv(request.get("tmuxAttachArgv"))
        iterm_session_id = validate_iterm_session_id(request.get("itermSessionId"))

        if tmux_attach_argv is not None:
            await open_iterm2_tab(connection, tmux_attach_argv)
            writer.write(response(True, message="Requested tmux attach in a new iTerm2 tab."))
        elif iterm_session_id is not None:
            focused = await focus_iterm2_session(connection, iterm_session_id)
            if focused:
                writer.write(response(True, message="Requested iTerm2 focus for selected session."))
            else:
                writer.write(
                    response(
                        False,
                        reason="terminal-target-missing",
                        message="iTerm2 session is no longer available.",
                    )
                )
        else:
            message = (
                INVALID_ATTACH_ARGV_MESSAGE
                if "tmuxAttachArgv" in request
                else INVALID_ITERM_SESSION_ID_MESSAGE
            )
            writer.write(response(False, reason="open-failed", message=message))
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
            response(False, reason="open-failed", message=f"Failed to request iTerm2 focus: {error}")
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
