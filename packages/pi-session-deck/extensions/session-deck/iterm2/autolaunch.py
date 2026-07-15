#!/usr/bin/env python3
"""Canonical iTerm2 AutoLaunch runtime for Session Deck.

This file is copied as the single installed AutoLaunch script.  It is safe to
import from ordinary Python tests: iTerm2 is imported only by ``run()`` or by the
runtime paths that actually use the iTerm2 API.
"""

from __future__ import annotations

import asyncio
import json
import os
import posixpath
import pwd
import re
import secrets
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

HOST = "127.0.0.1"
STATE_SCHEMA_VERSION = 1
STATE_PRODUCT = "pi-session-deck-iterm2"
STATE_RELATIVE_PATH = Path(".pi/session-deck/iterm2/install.json")
SCRIPT_FILENAME = "session_deck.py"
TOOL_DISPLAY_NAME = "Session Deck"
TOOL_IDENTIFIER = "dev.pi-userland.session-deck.toolbelt"
SNAPSHOT_ERROR_CODE = "toolbelt_snapshot_unavailable"
REQUEST_TIMEOUT_SECONDS = 2.0
SNAPSHOT_TIMEOUT_SECONDS = 10.0
ACTION_HELPER_TIMEOUT_SECONDS = 60.0
MAX_REQUEST_BYTES = 8192
ACTION_BODY_LIMIT_BYTES = 16 * 1024
ACTION_TOKEN_PLACEHOLDER = b"__SESSION_DECK_ACTION_TOKEN__"
EFFECTIVE_COMMAND_PATH_TIMEOUT_SECONDS = 3.0
EFFECTIVE_COMMAND_PATH_MARKER_PREFIX = "__SESSION_DECK_EFFECTIVE_PATH__"
EFFECTIVE_COMMAND_PATH_START_MARKER = f"{EFFECTIVE_COMMAND_PATH_MARKER_PREFIX}_START"
EFFECTIVE_COMMAND_PATH_END_MARKER = f"{EFFECTIVE_COMMAND_PATH_MARKER_PREFIX}_END"
CONFIGURED_LOGIN_SHELL_PATH_PROVENANCE = "configured login shell"
ENV_LOGIN_SHELL_PATH_PROVENANCE = "$SHELL login shell fallback"
INHERITED_PATH_PROVENANCE = "inherited process PATH fallback"
OS_DEFPATH_PROVENANCE = "os.defpath fallback"
HELPER_UNAVAILABLE_MESSAGE = "Create-worktree action is unavailable. Run /session-deck iterm2 doctor."
HELPER_INVALID_RESPONSE_MESSAGE = (
    "Create-worktree action failed because the helper returned an invalid response. "
    "Refresh Session Deck, run /session-deck iterm2 doctor, and check git worktrees before retrying."
)
HELPER_TIMEOUT_MESSAGE = (
    "Create-worktree action did not finish before the helper timeout. "
    "Refresh Session Deck, run /session-deck iterm2 doctor, and check git worktrees before retrying."
)
HELPER_FAILED_MESSAGE = "Create-worktree action failed. Run /session-deck iterm2 doctor if this keeps happening."
BROWSER_FORBIDDEN_FIELDS = {
    "label",
    "cwd",
    "gitRoot",
    "worktreeRoot",
    "path",
    "manualCommand",
    "manualAttachCommand",
    "tmuxSessionName",
    "tmuxTarget",
    "paneId",
    "itermSessionId",
    "tmuxArgv",
    "tmuxCommand",
    "piArgv",
    "piCommand",
    "shell",
    "command",
    "socketPath",
    "sessionFile",
}
PRIVATE_PATH_RE = re.compile(r"(?<![A-Za-z0-9._-])(/(?:[^/\s]+/)+[^/\s]+)")

INVALID_ATTACH_ARGV_MESSAGE = "Bridge only accepts exact tmux attach argv in 'tmuxAttachArgv'."
INVALID_ITERM_SESSION_ID_MESSAGE = "Bridge only accepts non-empty iTerm2 session ids in 'itermSessionId'."

STATIC_CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}
REQUIRED_WEB_ASSETS = ("index.html", "app.js", "style.css")
REQUEST_OPERATIONS = ("ping", "itermSessionId", "launchPrereqs", "tmuxAttachArgv")

STARTED_AT = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class StartupError(RuntimeError):
    """Raised when the AutoLaunch runtime cannot safely start."""


@dataclass(frozen=True)
class ScriptConfig:
    path: Path
    sha256: str


@dataclass(frozen=True)
class RuntimeConfig:
    node_executable_path: Path
    snapshot_helper_path: Path
    create_worktree_helper_path: Path
    web_root_path: Path
    bridge_socket_path: Path


@dataclass(frozen=True)
class InstallConfig:
    package_version: str
    installed_at: str
    scripts_dir: Path
    script: ScriptConfig
    runtime: RuntimeConfig


@dataclass(frozen=True)
class SocketIdentity:
    device: int
    inode: int


@dataclass(frozen=True)
class EffectiveCommandPath:
    value: str
    provenance: str


@dataclass
class HttpRuntime:
    server: ThreadingHTTPServer
    thread: threading.Thread

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)


@dataclass
class BridgeRuntime:
    server: asyncio.AbstractServer
    socket_path: Path
    socket_identity: SocketIdentity

    async def close(self) -> None:
        self.server.close()
        await self.server.wait_closed()
        unlink_socket_if_owned(self.socket_path, self.socket_identity)


@dataclass
class SessionDeckRuntime:
    config: InstallConfig
    http: HttpRuntime
    bridge: BridgeRuntime

    async def close(self) -> None:
        bridge_error: Optional[BaseException] = None
        try:
            await self.bridge.close()
        except BaseException as exc:  # Preserve HTTP cleanup even if bridge cleanup fails.
            bridge_error = exc
        self.http.close()
        if bridge_error is not None:
            raise bridge_error


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def default_state_path(home: Optional[Path] = None) -> Path:
    return (home if home is not None else Path.home()) / STATE_RELATIVE_PATH


def load_config(state_path: Optional[Path] = None) -> InstallConfig:
    path = state_path if state_path is not None else default_state_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise StartupError(f"Session Deck iTerm2 install state not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise StartupError(f"Session Deck iTerm2 install state is invalid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise StartupError("Session Deck iTerm2 install state root must be an object.")

    return parse_config(payload)


def parse_config(payload: dict[str, Any]) -> InstallConfig:
    require_exact_keys(
        payload,
        ("schemaVersion", "product", "packageVersion", "installedAt", "scriptsDir", "script", "runtime"),
        "root",
    )
    require_equal(payload.get("schemaVersion"), STATE_SCHEMA_VERSION, "schemaVersion")
    require_equal(payload.get("product"), STATE_PRODUCT, "product")

    script = require_object(payload.get("script"), "script")
    require_exact_keys(script, ("path", "sha256"), "script")
    runtime = require_object(payload.get("runtime"), "runtime")
    require_exact_keys(
        runtime,
        ("nodeExecutablePath", "snapshotHelperPath", "webRootPath", "bridgeSocketPath"),
        "runtime",
    )

    scripts_dir = require_absolute_path(payload.get("scriptsDir"), "scriptsDir")
    script_config = ScriptConfig(
        path=require_absolute_path(script.get("path"), "script.path"),
        sha256=require_sha256(script.get("sha256"), "script.sha256"),
    )
    expected_script_path = scripts_dir / "AutoLaunch" / SCRIPT_FILENAME
    if script_config.path != expected_script_path:
        raise StartupError("Session Deck iTerm2 install state field script.path must match scriptsDir.")

    return InstallConfig(
        package_version=require_non_empty_string(payload.get("packageVersion"), "packageVersion"),
        installed_at=require_non_empty_string(payload.get("installedAt"), "installedAt"),
        scripts_dir=scripts_dir,
        script=script_config,
        runtime=build_runtime_config(runtime),
    )


def build_runtime_config(runtime: dict[str, Any]) -> RuntimeConfig:
    snapshot_helper_path = require_absolute_path(
        runtime.get("snapshotHelperPath"), "runtime.snapshotHelperPath"
    )
    return RuntimeConfig(
        node_executable_path=require_absolute_path(
            runtime.get("nodeExecutablePath"), "runtime.nodeExecutablePath"
        ),
        snapshot_helper_path=snapshot_helper_path,
        create_worktree_helper_path=derive_create_worktree_helper_path(snapshot_helper_path),
        web_root_path=require_absolute_path(runtime.get("webRootPath"), "runtime.webRootPath"),
        bridge_socket_path=require_absolute_path(
            runtime.get("bridgeSocketPath"), "runtime.bridgeSocketPath"
        ),
    )


def derive_create_worktree_helper_path(snapshot_helper_path: Path) -> Path:
    return snapshot_helper_path.parent.parent / "worktree" / "action-cli.js"


def require_exact_keys(candidate: dict[str, Any], expected: tuple[str, ...], field: str) -> None:
    if set(candidate.keys()) != set(expected):
        raise StartupError(f"Session Deck iTerm2 install state field {field} has an invalid shape.")


def require_equal(candidate: Any, expected: Any, field: str) -> None:
    if candidate != expected:
        raise StartupError(f"Session Deck iTerm2 install state has invalid {field}.")


def require_object(candidate: Any, field: str) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        raise StartupError(f"Session Deck iTerm2 install state field {field} must be an object.")
    return candidate


def require_non_empty_string(candidate: Any, field: str) -> str:
    if not isinstance(candidate, str) or len(candidate.strip()) == 0:
        raise StartupError(f"Session Deck iTerm2 install state field {field} must be a non-empty string.")
    return candidate


def require_absolute_path(candidate: Any, field: str) -> Path:
    value = require_non_empty_string(candidate, field)
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise StartupError(f"Session Deck iTerm2 install state field {field} must be an absolute path.")
    return path


def require_sha256(candidate: Any, field: str) -> str:
    value = require_non_empty_string(candidate, field)
    if len(value) != 64 or any(character not in "0123456789abcdefABCDEF" for character in value):
        raise StartupError(f"Session Deck iTerm2 install state field {field} must be a SHA-256 hex digest.")
    return value.lower()


def validate_runtime_assets(config: InstallConfig) -> None:
    web_root = config.runtime.web_root_path
    if not web_root.exists() or not web_root.is_dir():
        raise StartupError(f"Session Deck iTerm2 web root not found: {web_root}")

    for filename in REQUIRED_WEB_ASSETS:
        asset = web_root / filename
        if not asset.exists() or not asset.is_file():
            raise StartupError(f"Session Deck iTerm2 required web asset not found: {asset}")


def validate_installed_script_hash(config: InstallConfig) -> None:
    """Verify the copied runtime if this process is running from the recorded path."""

    try:
        current_path = Path(__file__).resolve()
        recorded_path = config.script.path.resolve()
    except OSError:
        return

    if current_path != recorded_path:
        return

    try:
        digest = sha256(recorded_path.read_bytes()).hexdigest()
    except OSError as exc:
        raise StartupError(f"Could not read installed Session Deck iTerm2 runtime: {exc}") from exc

    if digest != config.script.sha256:
        raise StartupError("Installed Session Deck iTerm2 runtime hash does not match install state.")


def fallback_effective_command_path() -> EffectiveCommandPath:
    inherited_path = os.environ.get("PATH")
    if isinstance(inherited_path, str) and len(inherited_path) > 0:
        return EffectiveCommandPath(value=inherited_path, provenance=INHERITED_PATH_PROVENANCE)
    return EffectiveCommandPath(value=os.defpath, provenance=OS_DEFPATH_PROVENANCE)


def normalize_login_shell_path(candidate: Any) -> Optional[Path]:
    if not isinstance(candidate, str):
        return None

    value = candidate.strip()
    if len(value) == 0:
        return None

    path = Path(value)
    if not path.is_absolute():
        return None
    if not os.access(str(path), os.X_OK):
        return None
    return path


def select_login_shell() -> Optional[tuple[Path, str]]:
    try:
        shell_path = normalize_login_shell_path(pwd.getpwuid(os.getuid()).pw_shell)
    except (AttributeError, KeyError, OSError):
        shell_path = None

    if shell_path is not None:
        return shell_path, f"{CONFIGURED_LOGIN_SHELL_PATH_PROVENANCE} ({shell_path})"

    env_shell = normalize_login_shell_path(os.environ.get("SHELL"))
    if env_shell is not None:
        return env_shell, f"{ENV_LOGIN_SHELL_PATH_PROVENANCE} ({env_shell})"

    return None


def build_effective_command_path_probe_command() -> str:
    return (
        f"/usr/bin/printf '%s\\n' {shlex.quote(EFFECTIVE_COMMAND_PATH_START_MARKER)}; "
        f"/usr/bin/printenv PATH; "
        f"/usr/bin/printf '%s\\n' {shlex.quote(EFFECTIVE_COMMAND_PATH_END_MARKER)}"
    )


def parse_effective_command_path_output(stdout: bytes) -> Optional[str]:
    lines = stdout.splitlines()
    start_marker = EFFECTIVE_COMMAND_PATH_START_MARKER.encode("utf-8")
    end_marker = EFFECTIVE_COMMAND_PATH_END_MARKER.encode("utf-8")

    try:
        start_index = lines.index(start_marker)
        end_index = lines.index(end_marker, start_index + 1)
    except ValueError:
        return None

    if end_index != start_index + 2:
        return None

    path_bytes = lines[start_index + 1]
    if len(path_bytes) == 0 or b"\x00" in path_bytes:
        return None

    try:
        return path_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return None


def resolve_effective_command_path() -> EffectiveCommandPath:
    fallback = fallback_effective_command_path()
    shell_selection = select_login_shell()
    if shell_selection is None:
        return fallback

    shell_path, provenance = shell_selection
    try:
        completed = subprocess.run(
            [f"-{shell_path.name}", "-i", "-c", build_effective_command_path_probe_command()],
            executable=str(shell_path),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=EFFECTIVE_COMMAND_PATH_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return fallback

    if completed.returncode != 0:
        return fallback

    path_value = parse_effective_command_path_output(completed.stdout)
    if path_value is None:
        return fallback

    return EffectiveCommandPath(value=path_value, provenance=provenance)


def build_child_process_env(effective_command_path: EffectiveCommandPath) -> dict[str, str]:
    return {**os.environ, "PATH": effective_command_path.value}


def empty_snapshot(message: str) -> dict[str, Any]:
    return {
        "generatedAt": utc_now_iso(),
        "records": [],
        "diagnostics": [
            {
                "code": SNAPSHOT_ERROR_CODE,
                "message": message,
            }
        ],
    }


def read_snapshot(
    config: InstallConfig,
    effective_command_path: EffectiveCommandPath,
) -> dict[str, Any]:
    helper_path = config.runtime.snapshot_helper_path
    if not helper_path.exists():
        return empty_snapshot(f"Snapshot helper not found: {helper_path}")

    try:
        completed = subprocess.run(
            [str(config.runtime.node_executable_path), str(helper_path)],
            capture_output=True,
            check=False,
            text=True,
            timeout=SNAPSHOT_TIMEOUT_SECONDS,
            env=build_child_process_env(effective_command_path),
        )
    except Exception as exc:
        return empty_snapshot(f"Could not run snapshot helper: {exc}")

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or f"exit {completed.returncode}").strip()
        return empty_snapshot(f"Snapshot helper failed: {detail}")

    try:
        payload = json.loads(completed.stdout)
    except Exception as exc:
        return empty_snapshot(f"Snapshot JSON is invalid: {exc}")

    if not isinstance(payload, dict):
        return empty_snapshot("Snapshot root is not an object")

    return payload


def build_launch_prereq_report(effective_command_path: EffectiveCommandPath) -> dict[str, Any]:
    return {
        "pathProvenance": effective_command_path.provenance,
        "tmux": describe_executable_on_path("tmux", effective_command_path),
        "pi": describe_executable_on_path("pi", effective_command_path),
    }


def describe_executable_on_path(
    command: str,
    effective_command_path: EffectiveCommandPath,
) -> dict[str, Any]:
    resolved = shutil.which(command, path=effective_command_path.value)
    if resolved is None:
        return {"status": "missing"}
    return {"status": "available", "path": resolved}


def helper_failure_payload(message: str) -> dict[str, Any]:
    return {"ok": False, "status": "failed", "message": message}


def sanitize_helper_failure_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if find_forbidden_field(payload) is not None:
        return helper_failure_payload(HELPER_FAILED_MESSAGE)

    sanitized = redact_private_data(payload)
    if not isinstance(sanitized, dict):
        return helper_failure_payload(HELPER_FAILED_MESSAGE)

    message = sanitized.get("message")
    sanitized["ok"] = False
    if not isinstance(sanitized.get("status"), str):
        sanitized["status"] = "failed"
    if not isinstance(message, str) or len(message.strip()) == 0:
        sanitized["message"] = HELPER_FAILED_MESSAGE
    return sanitized


def find_forbidden_field(value: Any, prefix: str = "") -> Optional[str]:
    if not isinstance(value, dict):
        return None

    for key, child in value.items():
        path = key if len(prefix) == 0 else f"{prefix}.{key}"
        if key in BROWSER_FORBIDDEN_FIELDS:
            return path
        nested = find_forbidden_field(child, path)
        if nested is not None:
            return nested

    return None


def redact_private_data(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: redact_private_data(child) for key, child in value.items()}
    if isinstance(value, list):
        return [redact_private_data(child) for child in value]
    if isinstance(value, str):
        return redact_private_paths(value)
    return value


def redact_private_paths(text: str) -> str:
    return PRIVATE_PATH_RE.sub("[private path]", text)


def run_create_worktree_action(
    config: InstallConfig,
    payload: str,
    effective_command_path: EffectiveCommandPath,
) -> tuple[int, dict[str, Any]]:
    helper_path = config.runtime.create_worktree_helper_path
    if not helper_path.exists():
        return 503, helper_failure_payload(HELPER_UNAVAILABLE_MESSAGE)

    try:
        completed = subprocess.run(
            [str(config.runtime.node_executable_path), str(helper_path)],
            input=payload,
            capture_output=True,
            check=False,
            text=True,
            timeout=ACTION_HELPER_TIMEOUT_SECONDS,
            env=build_child_process_env(effective_command_path),
        )
    except subprocess.TimeoutExpired:
        return 504, helper_failure_payload(HELPER_TIMEOUT_MESSAGE)
    except Exception:
        return 500, helper_failure_payload(HELPER_UNAVAILABLE_MESSAGE)

    try:
        response_payload = json.loads(completed.stdout)
    except Exception:
        return 500, helper_failure_payload(HELPER_INVALID_RESPONSE_MESSAGE)

    if not isinstance(response_payload, dict):
        return 500, helper_failure_payload(HELPER_INVALID_RESPONSE_MESSAGE)

    if completed.returncode != 0:
        return 400, sanitize_helper_failure_payload(response_payload)

    return 200, response_payload


def resolve_static_path(config: InstallConfig, pathname: str) -> Optional[Path]:
    normalized = "/index.html" if pathname in ("", "/") else pathname
    normalized = posixpath.normpath(normalized)
    if normalized.startswith("../") or "/../" in normalized:
        return None

    web_root = config.runtime.web_root_path.resolve()
    candidate = (web_root / normalized.lstrip("/")).resolve()
    if candidate != web_root and web_root not in candidate.parents:
        return None

    return candidate


class SessionDeckToolbeltHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        config = self.server.session_deck_config  # type: ignore[attr-defined]
        effective_command_path = self.server.session_deck_effective_command_path  # type: ignore[attr-defined]
        parsed = urlparse(self.path)
        pathname = parsed.path

        if pathname == "/snapshot.json":
            self.send_json(200, read_snapshot(config, effective_command_path))
            return

        if pathname == "/healthz":
            self.send_json(
                200,
                {
                    "service": TOOL_IDENTIFIER,
                    "pid": os.getpid(),
                    "port": self.server.server_address[1],
                    "startedAt": STARTED_AT,
                    "packageVersion": config.package_version,
                    "helperScriptPath": str(config.runtime.snapshot_helper_path),
                    "createWorktreeHelperScriptPath": str(config.runtime.create_worktree_helper_path),
                    "webRoot": str(config.runtime.web_root_path),
                },
            )
            return

        static_path = resolve_static_path(config, pathname)
        if static_path is None or not static_path.exists() or not static_path.is_file():
            self.send_text(404, "Not found")
            return

        content_type = STATIC_CONTENT_TYPES.get(static_path.suffix)
        if content_type is None:
            self.send_text(404, "Not found")
            return

        try:
            payload = static_path.read_bytes()
            if pathname in ("", "/", "/index.html") and static_path.name == "index.html":
                token = self.server.session_deck_action_token  # type: ignore[attr-defined]
                payload = payload.replace(ACTION_TOKEN_PLACEHOLDER, token.encode("utf-8"))
            self.send_bytes(200, content_type, payload)
        except Exception:
            self.send_text(404, "Not found")

    def do_POST(self) -> None:
        config = self.server.session_deck_config  # type: ignore[attr-defined]
        effective_command_path = self.server.session_deck_effective_command_path  # type: ignore[attr-defined]
        parsed = urlparse(self.path)
        if parsed.path not in ("/actions/create-worktree", "/actions/create-worktree-preview"):
            self.send_json(404, {"ok": False, "status": "failed", "message": "Not found"})
            return

        action_token = self.server.session_deck_action_token  # type: ignore[attr-defined]
        if self.headers.get("X-Session-Deck-Action-Token") != action_token:
            self.send_json(403, {"ok": False, "status": "failed", "message": "Invalid action token."})
            return

        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            self.send_json(
                415,
                {"ok": False, "status": "failed", "message": "Content-Type must be application/json."},
            )
            return

        content_length = self.headers.get("Content-Length")
        try:
            body_length = int(content_length) if content_length is not None else 0
        except ValueError:
            body_length = 0
        if body_length <= 0 or body_length > ACTION_BODY_LIMIT_BYTES:
            self.send_json(
                413,
                {"ok": False, "status": "failed", "message": "Request body is empty or too large."},
            )
            return

        body = self.rfile.read(body_length).decode("utf-8")
        status_code, response_payload = run_create_worktree_action(
            config,
            body,
            effective_command_path,
        )
        self.send_json(status_code, response_payload)

    def log_message(self, _format: str, *args: Any) -> None:
        return

    def send_json(self, status_code: int, payload: Any) -> None:
        self.send_bytes(
            status_code,
            "application/json; charset=utf-8",
            (json.dumps(payload) + "\n").encode("utf-8"),
        )

    def send_text(self, status_code: int, text: str) -> None:
        self.send_bytes(status_code, "text/plain; charset=utf-8", text.encode("utf-8"))

    def send_bytes(self, status_code: int, content_type: str, payload: bytes) -> None:
        self.send_response(status_code)
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        )
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_http_server(
    config: InstallConfig,
    effective_command_path: EffectiveCommandPath,
) -> HttpRuntime:
    server = ThreadingHTTPServer((HOST, 0), SessionDeckToolbeltHandler)
    server.session_deck_config = config  # type: ignore[attr-defined]
    server.session_deck_effective_command_path = effective_command_path  # type: ignore[attr-defined]
    server.session_deck_action_token = secrets.token_urlsafe(32)  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return HttpRuntime(server=server, thread=thread)


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


def get_iterm2_module() -> Any:
    import iterm2

    return iterm2


async def open_iterm2_tab(connection: Any, tmux_attach_argv: list[str]) -> None:
    iterm2 = get_iterm2_module()
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


async def focus_iterm2_session(connection: Any, iterm_session_id: str) -> bool:
    iterm2 = get_iterm2_module()
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
    connection: Any,
    ui_lock: asyncio.Lock,
    effective_command_path: EffectiveCommandPath,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=REQUEST_TIMEOUT_SECONDS)
        if len(line) == 0:
            writer.write(response(False, reason="open-failed", message="Bridge request was empty."))
            await writer.drain()
            return
        if len(line) > MAX_REQUEST_BYTES:
            writer.write(response(False, reason="open-failed", message="Bridge request is too large."))
            await writer.drain()
            return
        if not line.endswith(b"\n"):
            writer.write(
                response(False, reason="open-failed", message="Bridge request must end with a newline.")
            )
            await writer.drain()
            return

        request = json.loads(line.decode("utf-8"))
        if not isinstance(request, dict):
            writer.write(response(False, reason="open-failed", message="Bridge request must be an object."))
            await writer.drain()
            return

        operation_keys = [key for key in REQUEST_OPERATIONS if key in request]
        if len(operation_keys) != 1:
            writer.write(
                response(
                    False,
                    reason="open-failed",
                    message="Bridge request must include exactly one operation: ping, itermSessionId, launchPrereqs, or tmuxAttachArgv.",
                )
            )
            await writer.drain()
            return

        operation = operation_keys[0]
        if set(request.keys()) != {operation}:
            writer.write(
                response(False, reason="open-failed", message="Bridge request must contain only one operation.")
            )
            await writer.drain()
            return

        if operation == "ping":
            if request["ping"] is not True:
                writer.write(
                    response(False, reason="open-failed", message="Bridge ping request must be true.")
                )
            else:
                writer.write(response(True, message="pong"))
            await writer.drain()
            return

        if operation == "launchPrereqs":
            if request["launchPrereqs"] is not True:
                writer.write(
                    response(
                        False,
                        reason="open-failed",
                        message="Bridge launchPrereqs request must be true.",
                    )
                )
                await writer.drain()
                return
            writer.write(
                response(
                    True,
                    message="Reported launch prerequisites.",
                    launchPrereqs=build_launch_prereq_report(effective_command_path),
                )
            )
            await writer.drain()
            return

        if operation == "tmuxAttachArgv":
            tmux_attach_argv = validate_tmux_attach_argv(request.get("tmuxAttachArgv"))
            if tmux_attach_argv is None:
                writer.write(response(False, reason="open-failed", message=INVALID_ATTACH_ARGV_MESSAGE))
                await writer.drain()
                return
            async with ui_lock:
                await open_iterm2_tab(connection, tmux_attach_argv)
            writer.write(response(True, message="Requested tmux attach in a new iTerm2 tab."))
            await writer.drain()
            return

        iterm_session_id = validate_iterm_session_id(request.get("itermSessionId"))
        if iterm_session_id is None:
            writer.write(response(False, reason="open-failed", message=INVALID_ITERM_SESSION_ID_MESSAGE))
            await writer.drain()
            return

        async with ui_lock:
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
        await writer.drain()
    except json.JSONDecodeError as error:
        writer.write(response(False, reason="open-failed", message=f"Malformed JSON request: {error}"))
        await writer.drain()
    except (ValueError, asyncio.LimitOverrunError):
        writer.write(response(False, reason="open-failed", message="Bridge request is too large."))
        await writer.drain()
    except asyncio.TimeoutError:
        writer.write(response(False, reason="open-failed", message="Bridge request timed out."))
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


def ensure_secure_socket_parent(socket_path: Path) -> None:
    parent = socket_path.parent
    try:
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise StartupError(f"Could not create iTerm2 bridge socket directory {parent}: {exc}") from exc

    try:
        parent_stat = parent.lstat()
    except OSError as exc:
        raise StartupError(f"Could not inspect iTerm2 bridge socket directory {parent}: {exc}") from exc

    if not stat.S_ISDIR(parent_stat.st_mode):
        raise StartupError(f"iTerm2 bridge socket parent is not a directory: {parent}")

    if hasattr(os, "getuid") and parent_stat.st_uid != os.getuid():
        raise StartupError(f"iTerm2 bridge socket parent is not owned by the current user: {parent}")

    if parent_stat.st_mode & 0o077:
        try:
            parent.chmod(0o700)
            parent_stat = parent.lstat()
        except OSError as exc:
            raise StartupError(f"Could not secure iTerm2 bridge socket directory {parent}: {exc}") from exc

    if parent_stat.st_mode & 0o077:
        raise StartupError(f"iTerm2 bridge socket parent has unsafe permissions: {parent}")


def is_socket_path_active(socket_path: Path) -> bool:
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(0.2)
        probe.connect(str(socket_path))
        return True
    except (ConnectionRefusedError, FileNotFoundError):
        return False
    except OSError as exc:
        if getattr(exc, "errno", None) in (2, 61, 111):
            return False
        return True
    finally:
        probe.close()


def prepare_bridge_socket_path(socket_path: Path) -> None:
    ensure_secure_socket_parent(socket_path)

    try:
        existing = socket_path.lstat()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise StartupError(f"Could not inspect iTerm2 bridge socket path {socket_path}: {exc}") from exc

    if not stat.S_ISSOCK(existing.st_mode):
        raise StartupError(f"iTerm2 bridge socket path exists and is not a socket: {socket_path}")

    if is_socket_path_active(socket_path):
        raise StartupError(f"iTerm2 bridge socket is already active: {socket_path}")

    try:
        socket_path.unlink()
    except OSError as exc:
        raise StartupError(f"Could not remove stale iTerm2 bridge socket {socket_path}: {exc}") from exc


def current_socket_identity(socket_path: Path) -> SocketIdentity:
    try:
        socket_stat = socket_path.lstat()
    except OSError as exc:
        raise StartupError(f"Could not inspect iTerm2 bridge socket {socket_path}: {exc}") from exc

    if not stat.S_ISSOCK(socket_stat.st_mode):
        raise StartupError(f"iTerm2 bridge did not create a socket: {socket_path}")

    return SocketIdentity(device=socket_stat.st_dev, inode=socket_stat.st_ino)


def unlink_socket_if_owned(socket_path: Path, identity: SocketIdentity) -> None:
    try:
        socket_stat = socket_path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        return

    if not stat.S_ISSOCK(socket_stat.st_mode):
        return
    if socket_stat.st_dev != identity.device or socket_stat.st_ino != identity.inode:
        return

    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass


def unlink_stale_socket_after_failed_bind(socket_path: Path) -> None:
    try:
        socket_stat = socket_path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        return

    if not stat.S_ISSOCK(socket_stat.st_mode):
        return
    if is_socket_path_active(socket_path):
        return

    try:
        socket_path.unlink()
    except OSError:
        pass


async def start_bridge_server(
    config: InstallConfig,
    connection: Any,
    ui_lock: asyncio.Lock,
    effective_command_path: EffectiveCommandPath,
) -> BridgeRuntime:
    socket_path = config.runtime.bridge_socket_path
    prepare_bridge_socket_path(socket_path)

    try:
        server = await asyncio.start_unix_server(
            lambda reader, writer: handle_client(
                connection,
                ui_lock,
                effective_command_path,
                reader,
                writer,
            ),
            path=str(socket_path),
            limit=MAX_REQUEST_BYTES + 1,
        )
    except Exception:
        unlink_stale_socket_after_failed_bind(socket_path)
        raise

    try:
        identity = current_socket_identity(socket_path)
        try:
            socket_path.chmod(0o600)
        except OSError:
            pass
    except Exception:
        server.close()
        await server.wait_closed()
        unlink_stale_socket_after_failed_bind(socket_path)
        raise

    return BridgeRuntime(server=server, socket_path=socket_path, socket_identity=identity)


async def register_toolbelt(connection: Any, http: HttpRuntime, config: InstallConfig) -> None:
    iterm2 = get_iterm2_module()
    await iterm2.tool.async_register_web_view_tool(
        connection=connection,
        display_name=TOOL_DISPLAY_NAME,
        identifier=TOOL_IDENTIFIER,
        reveal_if_already_registered=True,
        url=f"http://{HOST}:{http.port}/",
    )


async def start_runtime(connection: Any, state_path: Optional[Path] = None) -> SessionDeckRuntime:
    config = load_config(state_path)
    validate_runtime_assets(config)
    validate_installed_script_hash(config)
    effective_command_path = resolve_effective_command_path()

    http: Optional[HttpRuntime] = None
    bridge: Optional[BridgeRuntime] = None
    try:
        http = start_http_server(config, effective_command_path)
        bridge = await start_bridge_server(config, connection, asyncio.Lock(), effective_command_path)
        await register_toolbelt(connection, http, config)
        return SessionDeckRuntime(config=config, http=http, bridge=bridge)
    except BaseException as startup_error:
        cleanup_error: Optional[BaseException] = None
        if bridge is not None:
            try:
                await bridge.close()
            except BaseException as exc:
                cleanup_error = exc
        if http is not None:
            http.close()
        if cleanup_error is not None:
            raise cleanup_error from startup_error
        raise


def install_shutdown_handlers(loop: asyncio.AbstractEventLoop, shutdown_requested: asyncio.Event) -> None:
    def request_shutdown() -> None:
        loop.call_soon_threadsafe(shutdown_requested.set)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_shutdown)
        except (NotImplementedError, RuntimeError):
            pass


async def main(connection: Any) -> None:
    runtime = await start_runtime(connection)
    loop = asyncio.get_running_loop()
    shutdown_requested = asyncio.Event()
    install_shutdown_handlers(loop, shutdown_requested)

    try:
        await shutdown_requested.wait()
    finally:
        await runtime.close()


def run() -> None:
    import iterm2

    iterm2.run_forever(main)


if __name__ == "__main__":
    run()
