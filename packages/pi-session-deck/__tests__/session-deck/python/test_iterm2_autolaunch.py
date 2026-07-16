from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

PACKAGE_ROOT = Path(__file__).resolve().parents[3]
AUTOLAUNCH_PATH = PACKAGE_ROOT / "extensions/session-deck/iterm2/autolaunch.py"
VALID_TMUX_ATTACH_ARGV = [
    "tmux",
    "-S",
    "/tmp/tmux socket/default",
    "attach-session",
    "-E",
    "-t",
    "$1",
]


def load_autolaunch(name: str = "session_deck_autolaunch_test"):
    spec = importlib.util.spec_from_file_location(name, AUTOLAUNCH_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


AUTO = load_autolaunch()


def make_effective_command_path(
    value: str = "/tools/session deck/bin:/usr/bin",
    provenance: str = "configured login shell (/bin/zsh)",
):
    return AUTO.EffectiveCommandPath(value=value, provenance=provenance)


class TempRuntime:
    def __init__(self, case: unittest.TestCase):
        self.case = case
        self.tempdir = tempfile.TemporaryDirectory()
        case.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.web_root = self.root / "web"
        self.web_root.mkdir()
        (self.web_root / "index.html").write_text("<main>Session Deck</main>", encoding="utf-8")
        (self.web_root / "app.js").write_text("console.log('session deck');", encoding="utf-8")
        (self.web_root / "style.css").write_text("body { color: black; }", encoding="utf-8")
        self.socket_path = self.root / "socket-parent" / "iterm2.sock"
        self.state_path = self.root / "install.json"
        self.helper_path = self.root / "dist/extensions/session-deck/worktree/action-cli.js"
        self.payload = {
            "schemaVersion": 1,
            "product": "pi-session-deck-iterm2",
            "packageVersion": "1.2.3",
            "installedAt": "2026-07-14T00:00:00.000Z",
            "scriptsDir": str(self.root / "Scripts"),
            "script": {
                "path": str(self.root / "Scripts/AutoLaunch/session_deck.py"),
                "sha256": "a" * 64,
            },
            "runtime": {
                "nodeExecutablePath": "/usr/bin/node",
                "snapshotHelperPath": str(
                    self.root / "dist/extensions/session-deck/iterm2/missing-snapshot-cli.js"
                ),
                "webRootPath": str(self.web_root),
                "bridgeSocketPath": str(self.socket_path),
            },
        }
        self.write_state()

    def write_state(self) -> None:
        self.state_path.write_text(json.dumps(self.payload), encoding="utf-8")

    def config(self):
        return AUTO.load_config(self.state_path)

    def write_helper(self, source: str) -> None:
        self.helper_path.parent.mkdir(parents=True, exist_ok=True)
        self.helper_path.write_text(source, encoding="utf-8")


def assert_browser_safe_payload(case: unittest.TestCase, payload: dict, *private_strings: str) -> None:
    rendered = json.dumps(payload)
    for private_string in private_strings:
        if len(private_string) == 0:
            continue
        case.assertNotIn(private_string, rendered)


def install_fake_iterm2(fake) -> None:
    sys.modules["iterm2"] = fake


def make_fake_iterm2(connection):
    async def async_get_app(received_connection):
        if received_connection is not connection:
            raise AssertionError("unexpected connection")
        return connection.app

    class WindowFactory:
        @staticmethod
        async def async_create(received_connection, command):
            if received_connection is not connection:
                raise AssertionError("unexpected connection")
            return await connection.create_window(command)

    return types.SimpleNamespace(async_get_app=async_get_app, Window=WindowFactory)


class FakeTab:
    def __init__(self, connection, window=None):
        self.connection = connection
        self.window = window

    async def async_select(self):
        self.connection.events.append("tab.select")


class FakeWindow:
    def __init__(self, connection):
        self.connection = connection
        self.current_tab = FakeTab(connection, self)

    async def async_create_tab(self, command):
        self.connection.active_tab_creations += 1
        self.connection.max_active_tab_creations = max(
            self.connection.max_active_tab_creations, self.connection.active_tab_creations
        )
        try:
            await asyncio.sleep(0.03)
            self.connection.commands.append(command)
            return FakeTab(self.connection, self)
        finally:
            self.connection.active_tab_creations -= 1

    async def async_activate(self):
        self.connection.events.append("window.activate")


class FakeSession:
    def __init__(self, connection, tab):
        self.connection = connection
        self.tab = tab
        self.activated = False

    async def async_activate(self):
        self.activated = True
        self.connection.events.append("session.activate")


class FakeApp:
    def __init__(self, connection):
        self.connection = connection
        self.current_terminal_window = FakeWindow(connection)
        self.sessions = {}

    async def async_activate(self):
        self.connection.events.append("app.activate")

    def get_session_by_id(self, session_id):
        return self.sessions.get(session_id)


class FakeConnection:
    def __init__(self):
        self.events = []
        self.commands = []
        self.active_tab_creations = 0
        self.max_active_tab_creations = 0
        self.app = FakeApp(self)

    async def create_window(self, command):
        self.commands.append(command)
        return FakeWindow(self)


async def unix_json_request(socket_path: Path, payload: bytes) -> dict:
    reader, writer = await asyncio.open_unix_connection(str(socket_path))
    writer.write(payload)
    await writer.drain()
    line = await asyncio.wait_for(reader.readline(), timeout=1.0)
    writer.close()
    await writer.wait_closed()
    return json.loads(line.decode("utf-8"))


def bind_unix_socket(path: Path) -> socket.socket:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server_socket.bind(str(path))
    server_socket.listen(1)
    return server_socket


class EffectiveCommandPathTests(unittest.TestCase):
    def test_resolve_effective_command_path_uses_passwd_shell_login_argv_devnull_timeout_and_shell_false(
        self,
    ):
        shell_path = "/test/bin/zsh"
        resolved_path = "/opt/bin:/usr/bin"
        start_marker = AUTO.EFFECTIVE_COMMAND_PATH_START_MARKER
        end_marker = AUTO.EFFECTIVE_COMMAND_PATH_END_MARKER
        shell_stdout = (
            b"startup noise\n"
            + start_marker.encode("utf-8")
            + b"\n"
            + resolved_path.encode("utf-8")
            + b"\n"
            + end_marker.encode("utf-8")
            + b"\nmore noise\n"
        )
        captured: dict[str, object] = {}

        def fake_run(args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(args, 0, stdout=shell_stdout, stderr=b"stderr noise\n")

        with (
            mock.patch.dict(AUTO.os.environ, {"PATH": "/gui/bin:/usr/bin"}, clear=True),
            mock.patch.object(
                AUTO.pwd,
                "getpwuid",
                return_value=types.SimpleNamespace(pw_shell=shell_path),
            ),
            mock.patch.object(AUTO.os, "getuid", return_value=123),
            mock.patch.object(AUTO.os, "access", side_effect=lambda path, _mode: path == shell_path),
            mock.patch.object(AUTO.subprocess, "run", side_effect=fake_run),
        ):
            result = AUTO.resolve_effective_command_path()

        self.assertEqual(result, make_effective_command_path(resolved_path, f"configured login shell ({shell_path})"))
        argv = captured["args"]
        kwargs = captured["kwargs"]
        self.assertEqual(argv[0], "-zsh")
        self.assertEqual(argv[1:3], ["-i", "-c"])
        command = argv[3]
        self.assertIn("/usr/bin/printenv PATH", command)
        self.assertIn(start_marker, command)
        self.assertIn(end_marker, command)
        self.assertNotIn(resolved_path, command)
        self.assertEqual(kwargs["executable"], shell_path)
        self.assertIs(kwargs["stdin"], AUTO.subprocess.DEVNULL)
        self.assertTrue(kwargs["capture_output"])
        self.assertFalse(kwargs["check"])
        self.assertEqual(kwargs["timeout"], AUTO.EFFECTIVE_COMMAND_PATH_TIMEOUT_SECONDS)
        self.assertFalse(kwargs.get("shell", False))

    def test_resolve_effective_command_path_ignores_noise_and_preserves_metacharacter_data(self):
        shell_path = "/test/bin/bash"
        resolved_path = "/opt/bin:/tmp/with space:/tmp/\"quote\":/tmp/'single':/tmp/$HOME:/tmp/semicolon;dir:/tmp/`backticks`"
        start_marker = AUTO.EFFECTIVE_COMMAND_PATH_START_MARKER
        end_marker = AUTO.EFFECTIVE_COMMAND_PATH_END_MARKER
        shell_stdout = (
            b"stdout noise before\n"
            + start_marker.encode("utf-8")
            + b"\n"
            + resolved_path.encode("utf-8")
            + b"\n"
            + end_marker.encode("utf-8")
            + b"\nstdout noise after\n"
        )

        with (
            mock.patch.dict(AUTO.os.environ, {"PATH": "/gui/bin:/usr/bin"}, clear=True),
            mock.patch.object(
                AUTO.pwd,
                "getpwuid",
                return_value=types.SimpleNamespace(pw_shell=shell_path),
            ),
            mock.patch.object(AUTO.os, "getuid", return_value=123),
            mock.patch.object(AUTO.os, "access", side_effect=lambda path, _mode: path == shell_path),
            mock.patch.object(
                AUTO.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    ["-bash", "-i", "-c", "ignored"],
                    0,
                    stdout=shell_stdout,
                    stderr=b"stderr noise\n",
                ),
            ),
        ):
            result = AUTO.resolve_effective_command_path()

        self.assertEqual(result.value, resolved_path)
        self.assertEqual(result.provenance, f"configured login shell ({shell_path})")

    def test_resolve_effective_command_path_uses_absolute_shell_env_fallback(self):
        env_shell = "/env/shell/bash"
        resolved_path = "/env/bin:/usr/bin"
        start_marker = AUTO.EFFECTIVE_COMMAND_PATH_START_MARKER
        end_marker = AUTO.EFFECTIVE_COMMAND_PATH_END_MARKER
        shell_stdout = b"\n".join(
            [
                start_marker.encode("utf-8"),
                resolved_path.encode("utf-8"),
                end_marker.encode("utf-8"),
            ]
        ) + b"\n"

        def is_executable(path, _mode):
            return path == env_shell

        with (
            mock.patch.dict(
                AUTO.os.environ,
                {"PATH": "/gui/bin:/usr/bin", "SHELL": env_shell},
                clear=True,
            ),
            mock.patch.object(
                AUTO.pwd,
                "getpwuid",
                return_value=types.SimpleNamespace(pw_shell="relative-shell"),
            ),
            mock.patch.object(AUTO.os, "getuid", return_value=123),
            mock.patch.object(AUTO.os, "access", side_effect=is_executable),
            mock.patch.object(
                AUTO.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    ["-bash", "-i", "-c", "ignored"],
                    0,
                    stdout=shell_stdout,
                    stderr=b"",
                ),
            ),
        ):
            result = AUTO.resolve_effective_command_path()

        self.assertEqual(result, make_effective_command_path(resolved_path, f"$SHELL login shell fallback ({env_shell})"))

    def test_resolve_effective_command_path_falls_back_to_inherited_path_when_no_shell_is_available(self):
        inherited_path = "/gui/bin:/usr/bin"

        with (
            mock.patch.dict(AUTO.os.environ, {"PATH": inherited_path}, clear=True),
            mock.patch.object(AUTO.pwd, "getpwuid", side_effect=KeyError("missing passwd entry")),
            mock.patch.object(AUTO.os, "getuid", return_value=123),
            mock.patch.object(AUTO.subprocess, "run") as run_mock,
        ):
            result = AUTO.resolve_effective_command_path()

        self.assertEqual(result, make_effective_command_path(inherited_path, AUTO.INHERITED_PATH_PROVENANCE))
        run_mock.assert_not_called()

    def test_resolve_effective_command_path_falls_back_to_inherited_path_for_shell_failures(self):
        inherited_path = "/gui/bin:/usr/bin"
        shell_path = "/test/bin/zsh"
        start_marker = AUTO.EFFECTIVE_COMMAND_PATH_START_MARKER
        end_marker = AUTO.EFFECTIVE_COMMAND_PATH_END_MARKER
        framed = lambda payload: start_marker.encode("utf-8") + b"\n" + payload + b"\n" + end_marker.encode("utf-8") + b"\n"
        failures = {
            "timeout": subprocess.TimeoutExpired(["-zsh", "-i", "-c", "ignored"], 3.0),
            "oserror": OSError("boom"),
            "nonzero": subprocess.CompletedProcess(["-zsh", "-i", "-c", "ignored"], 1, stdout=framed(b"/shell/bin"), stderr=b""),
            "missing-frame": subprocess.CompletedProcess(["-zsh", "-i", "-c", "ignored"], 0, stdout=b"stdout noise only\n", stderr=b""),
            "empty-path": subprocess.CompletedProcess(["-zsh", "-i", "-c", "ignored"], 0, stdout=framed(b""), stderr=b""),
            "invalid-bytes": subprocess.CompletedProcess(["-zsh", "-i", "-c", "ignored"], 0, stdout=framed(b"\xff\xfe"), stderr=b""),
        }

        for label, outcome in failures.items():
            with self.subTest(label=label):
                def fake_run(*_args, **_kwargs):
                    if isinstance(outcome, BaseException):
                        raise outcome
                    return outcome

                with (
                    mock.patch.dict(AUTO.os.environ, {"PATH": inherited_path}, clear=True),
                    mock.patch.object(
                        AUTO.pwd,
                        "getpwuid",
                        return_value=types.SimpleNamespace(pw_shell=shell_path),
                    ),
                    mock.patch.object(AUTO.os, "getuid", return_value=123),
                    mock.patch.object(
                        AUTO.os,
                        "access",
                        side_effect=lambda path, _mode: path == shell_path,
                    ),
                    mock.patch.object(AUTO.subprocess, "run", side_effect=fake_run),
                ):
                    result = AUTO.resolve_effective_command_path()

                self.assertEqual(
                    result,
                    make_effective_command_path(inherited_path, AUTO.INHERITED_PATH_PROVENANCE),
                )

    def test_resolve_effective_command_path_uses_os_defpath_when_inherited_path_is_empty(self):
        with (
            mock.patch.dict(AUTO.os.environ, {"PATH": ""}, clear=True),
            mock.patch.object(AUTO.pwd, "getpwuid", side_effect=KeyError("missing passwd entry")),
            mock.patch.object(AUTO.os, "getuid", return_value=123),
        ):
            result = AUTO.resolve_effective_command_path()

        self.assertEqual(result, make_effective_command_path(AUTO.os.defpath, AUTO.OS_DEFPATH_PROVENANCE))

    def test_build_child_process_env_replaces_only_path_without_mutating_os_environ(self):
        original_path = "/gui/bin:/usr/bin"
        effective_path = make_effective_command_path("/shell/bin:/usr/bin")

        with (
            mock.patch.dict(
                AUTO.os.environ,
                {"PATH": original_path, "HOME": "/Users/session-deck", "TMPDIR": "/tmp/runtime"},
                clear=True,
            ),
            mock.patch.object(AUTO.pwd, "getpwuid", side_effect=KeyError("missing passwd entry")),
        ):
            child_env = AUTO.build_child_process_env(effective_path)
            fallback = AUTO.resolve_effective_command_path()
            self.assertEqual(AUTO.os.environ["PATH"], original_path)

        self.assertEqual(child_env["PATH"], effective_path.value)
        self.assertEqual(child_env["HOME"], "/Users/session-deck")
        self.assertEqual(child_env["TMPDIR"], "/tmp/runtime")
        self.assertEqual(fallback.value, original_path)
        self.assertEqual(fallback.provenance, AUTO.INHERITED_PATH_PROVENANCE)

    def test_snapshot_and_action_helpers_receive_same_effective_path_and_inherited_env(self):
        fixture = TempRuntime(self)
        effective_path = make_effective_command_path("/shell/bin:/usr/bin")
        snapshot_helper = fixture.root / "dist/extensions/session-deck/iterm2/snapshot-cli.js"
        snapshot_helper.parent.mkdir(parents=True, exist_ok=True)
        snapshot_helper.write_text(
            "import json, os\n"
            "print(json.dumps({\n"
            "  'records': [],\n"
            "  'diagnostics': [],\n"
            "  'pathOk': os.environ.get('PATH') == os.environ.get('EXPECTED_EFFECTIVE_PATH'),\n"
            "  'homeOk': os.environ.get('HOME') == os.environ.get('EXPECTED_HOME'),\n"
            "}))\n",
            encoding="utf-8",
        )
        fixture.write_helper(
            "import json, os, sys\n"
            "sys.stdin.read()\n"
            "print(json.dumps({\n"
            "  'ok': True,\n"
            "  'status': 'created',\n"
            "  'pathOk': os.environ.get('PATH') == os.environ.get('EXPECTED_EFFECTIVE_PATH'),\n"
            "  'homeOk': os.environ.get('HOME') == os.environ.get('EXPECTED_HOME'),\n"
            "}))\n"
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.payload["runtime"]["snapshotHelperPath"] = str(snapshot_helper)
        fixture.write_state()
        config = fixture.config()

        with mock.patch.dict(
            AUTO.os.environ,
            {
                "PATH": "/gui/bin:/usr/bin",
                "HOME": "/Users/session-deck",
                "EXPECTED_EFFECTIVE_PATH": effective_path.value,
                "EXPECTED_HOME": "/Users/session-deck",
            },
            clear=True,
        ):
            snapshot = AUTO.read_snapshot(config, effective_path)
            status_code, action_payload = AUTO.run_create_worktree_action(config, "{}", effective_path)
            self.assertEqual(AUTO.os.environ["PATH"], "/gui/bin:/usr/bin")

        self.assertTrue(snapshot["pathOk"])
        self.assertTrue(snapshot["homeOk"])
        self.assertEqual(status_code, 200)
        self.assertTrue(action_payload["pathOk"])
        self.assertTrue(action_payload["homeOk"])


class ImportAndConfigTests(unittest.TestCase):
    def test_import_is_safe_and_entrypoint_is_canonical(self):
        old_iterm2 = sys.modules.pop("iterm2", None)
        try:
            module = load_autolaunch("session_deck_autolaunch_import_safe_test")
            self.assertEqual(module.TOOL_DISPLAY_NAME, "Session Deck")
            self.assertNotIn("iterm2", sys.modules)
        finally:
            sys.modules.pop("session_deck_autolaunch_import_safe_test", None)
            if old_iterm2 is not None:
                sys.modules["iterm2"] = old_iterm2

        source = AUTOLAUNCH_PATH.read_text(encoding="utf-8")
        self.assertEqual(source.count("iterm2.run_forever(main)"), 1)
        self.assertIn('if __name__ == "__main__":\n    run()', source)

    def test_run_is_the_only_place_that_starts_iterm2(self):
        calls = []
        fake = types.SimpleNamespace(run_forever=lambda main: calls.append(main))
        old_iterm2 = sys.modules.get("iterm2")
        install_fake_iterm2(fake)
        try:
            AUTO.run()
        finally:
            if old_iterm2 is None:
                sys.modules.pop("iterm2", None)
            else:
                sys.modules["iterm2"] = old_iterm2

        self.assertEqual(calls, [AUTO.main])

    def test_loads_clean_schema_v1_and_validates_required_web_assets(self):
        fixture = TempRuntime(self)

        config = fixture.config()
        self.assertEqual(config.package_version, "1.2.3")
        self.assertEqual(config.runtime.bridge_socket_path, fixture.socket_path)
        self.assertEqual(
            config.runtime.create_worktree_helper_path,
            fixture.root / "dist/extensions/session-deck/worktree/action-cli.js",
        )
        AUTO.validate_runtime_assets(config)

        (fixture.web_root / "app.js").unlink()
        with self.assertRaisesRegex(AUTO.StartupError, "required web asset"):
            AUTO.validate_runtime_assets(config)

    def test_rejects_invalid_state_contract(self):
        fixture = TempRuntime(self)
        fixture.payload["schemaVersion"] = 2
        fixture.write_state()

        with self.assertRaisesRegex(AUTO.StartupError, "schemaVersion"):
            AUTO.load_config(fixture.state_path)

        fixture = TempRuntime(self)
        fixture.payload["runtime"]["socketPath"] = str(fixture.socket_path)
        fixture.write_state()

        with self.assertRaisesRegex(AUTO.StartupError, "runtime.*invalid shape"):
            AUTO.load_config(fixture.state_path)

        fixture = TempRuntime(self)
        fixture.payload["script"]["path"] = str(fixture.root / "elsewhere.py")
        fixture.write_state()

        with self.assertRaisesRegex(AUTO.StartupError, "script.path must match scriptsDir"):
            AUTO.load_config(fixture.state_path)

    def test_toolbelt_http_serves_health_static_assets_and_soft_snapshot_failure(self):
        fixture = TempRuntime(self)
        config = fixture.config()
        effective_command_path = make_effective_command_path("/secret/effective/bin:/usr/bin")
        http = AUTO.start_http_server(config, effective_command_path)
        self.addCleanup(http.close)
        base_url = f"http://127.0.0.1:{http.port}"

        with urlopen(f"{base_url}/healthz", timeout=1.0) as response:
            health = json.loads(response.read().decode("utf-8"))
        self.assertEqual(health["service"], "dev.pi-userland.session-deck.toolbelt")
        self.assertEqual(health["packageVersion"], "1.2.3")
        self.assertEqual(health["webRoot"], str(fixture.web_root))
        self.assertEqual(
            health["createWorktreeHelperScriptPath"],
            str(config.runtime.create_worktree_helper_path),
        )
        self.assertNotIn(effective_command_path.value, json.dumps(health))

        with urlopen(f"{base_url}/", timeout=1.0) as response:
            self.assertEqual(response.headers["Content-Type"], "text/html; charset=utf-8")
            html = response.read().decode("utf-8")
            self.assertIn("Session Deck", html)
            self.assertNotIn("__SESSION_DECK_ACTION_TOKEN__", html)

        with urlopen(f"{base_url}/snapshot.json", timeout=1.0) as response:
            snapshot = json.loads(response.read().decode("utf-8"))
        self.assertEqual(snapshot["records"], [])
        self.assertEqual(snapshot["diagnostics"][0]["code"], "toolbelt_snapshot_unavailable")
        self.assertIn("Snapshot helper not found", snapshot["diagnostics"][0]["message"])
        self.assertNotIn(effective_command_path.value, json.dumps(snapshot))

        with self.assertRaises(HTTPError) as raised:
            urlopen(f"{base_url}/missing.js", timeout=1.0)
        self.assertEqual(raised.exception.code, 404)

    def test_toolbelt_create_worktree_action_requires_token_and_runs_helper(self):
        fixture = TempRuntime(self)
        fixture.write_helper(
            "import json, sys\n"
            "payload = json.loads(sys.stdin.read())\n"
            "print(json.dumps({'ok': True, 'status': 'created', 'repoPath': payload['repoPath']}))\n"
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()
        config = fixture.config()
        http = AUTO.start_http_server(config, make_effective_command_path())
        self.addCleanup(http.close)
        base_url = f"http://127.0.0.1:{http.port}"

        token = http.server.session_deck_action_token
        payload = json.dumps({"repoPath": str(fixture.root)}).encode("utf-8")
        request = Request(
            f"{base_url}/actions/create-worktree",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Session-Deck-Action-Token": token,
            },
        )

        with urlopen(request, timeout=1.0) as response:
            action_result = json.loads(response.read().decode("utf-8"))
        self.assertEqual(action_result, {"ok": True, "status": "created", "repoPath": str(fixture.root)})

        missing_token = Request(
            f"{base_url}/actions/create-worktree",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(HTTPError) as raised:
            urlopen(missing_token, timeout=1.0)
        self.assertEqual(raised.exception.code, 403)

    def test_toolbelt_create_worktree_preview_route_runs_helper(self):
        fixture = TempRuntime(self)
        fixture.write_helper(
            "import json, sys\n"
            "payload = json.loads(sys.stdin.read())\n"
            "print(json.dumps({'ok': True, 'status': 'resolved', 'action': payload.get('action'), 'repoIntent': payload['repoIntent']}))\n"
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()
        config = fixture.config()
        http = AUTO.start_http_server(config, make_effective_command_path())
        self.addCleanup(http.close)
        base_url = f"http://127.0.0.1:{http.port}"

        token = http.server.session_deck_action_token
        payload = json.dumps(
            {
                "action": "preview-base-ref",
                "repoIntent": {"repoName": "project", "candidateRuntimeIds": ["rt-1"]},
            }
        ).encode("utf-8")
        request = Request(
            f"{base_url}/actions/create-worktree-preview",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Session-Deck-Action-Token": token,
            },
        )

        with urlopen(request, timeout=1.0) as response:
            action_result = json.loads(response.read().decode("utf-8"))
        self.assertEqual(
            action_result,
            {
                "ok": True,
                "status": "resolved",
                "action": "preview-base-ref",
                "repoIntent": {"repoName": "project", "candidateRuntimeIds": ["rt-1"]},
            },
        )

    def test_run_create_worktree_action_returns_browser_safe_helper_missing_failure(self):
        fixture = TempRuntime(self)
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()

        status_code, payload = AUTO.run_create_worktree_action(
            fixture.config(), "{}", make_effective_command_path()
        )

        self.assertEqual(status_code, 503)
        self.assertEqual(payload, AUTO.helper_failure_payload(AUTO.HELPER_UNAVAILABLE_MESSAGE))
        assert_browser_safe_payload(self, payload, str(fixture.root), str(fixture.helper_path))

    def test_run_create_worktree_action_sanitizes_nonzero_helper_failures(self):
        fixture = TempRuntime(self)
        fixture.write_helper(
            "import json, sys\n"
            "print(json.dumps({'ok': False, 'status': 'failed', 'message': 'bad /private/tmp/secret', 'path': '/Users/example/private'}))\n"
            "raise SystemExit(1)\n"
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()

        status_code, payload = AUTO.run_create_worktree_action(
            fixture.config(), "{}", make_effective_command_path()
        )

        self.assertEqual(status_code, 400)
        self.assertEqual(payload, AUTO.helper_failure_payload(AUTO.HELPER_FAILED_MESSAGE))
        assert_browser_safe_payload(self, payload, str(fixture.root), str(fixture.helper_path))
        self.assertNotIn("/private/tmp/secret", payload["message"])

    def test_run_create_worktree_action_reports_indeterminate_helper_timeout(self):
        fixture = TempRuntime(self)
        fixture.write_helper(
            "import time\n"
            "time.sleep(0.05)\n"
            "print('{}')\n"
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()
        original_timeout = AUTO.ACTION_HELPER_TIMEOUT_SECONDS
        AUTO.ACTION_HELPER_TIMEOUT_SECONDS = 0.01
        self.addCleanup(setattr, AUTO, "ACTION_HELPER_TIMEOUT_SECONDS", original_timeout)

        status_code, payload = AUTO.run_create_worktree_action(
            fixture.config(), "{}", make_effective_command_path()
        )

        self.assertEqual(status_code, 504)
        self.assertEqual(payload, AUTO.helper_failure_payload(AUTO.HELPER_TIMEOUT_MESSAGE))
        self.assertIn("check git worktrees", payload["message"])
        self.assertNotIn("no worktree was created", payload["message"].lower())
        assert_browser_safe_payload(self, payload, str(fixture.root), str(fixture.helper_path))

    def test_run_create_worktree_action_rejects_invalid_json_or_non_object_helper_output(self):
        fixture = TempRuntime(self)
        fixture.write_helper("print('/private/tmp/helper-output')\n")
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()

        invalid_json_status, invalid_json_payload = AUTO.run_create_worktree_action(
            fixture.config(), "{}", make_effective_command_path()
        )

        self.assertEqual(invalid_json_status, 500)
        self.assertEqual(
            invalid_json_payload, AUTO.helper_failure_payload(AUTO.HELPER_INVALID_RESPONSE_MESSAGE)
        )
        assert_browser_safe_payload(
            self, invalid_json_payload, str(fixture.root), str(fixture.helper_path)
        )

        fixture.write_helper("import json\nprint(json.dumps(['not', 'an', 'object']))\n")
        non_object_status, non_object_payload = AUTO.run_create_worktree_action(
            fixture.config(), "{}", make_effective_command_path()
        )

        self.assertEqual(non_object_status, 500)
        self.assertEqual(
            non_object_payload, AUTO.helper_failure_payload(AUTO.HELPER_INVALID_RESPONSE_MESSAGE)
        )
        assert_browser_safe_payload(
            self, non_object_payload, str(fixture.root), str(fixture.helper_path)
        )

    def test_toolbelt_create_worktree_route_rejects_invalid_content_type_and_large_body(self):
        fixture = TempRuntime(self)
        config = fixture.config()
        http = AUTO.start_http_server(config, make_effective_command_path())
        self.addCleanup(http.close)
        base_url = f"http://127.0.0.1:{http.port}"
        token = http.server.session_deck_action_token

        invalid_content_type = Request(
            f"{base_url}/actions/create-worktree",
            data=b"{}",
            method="POST",
            headers={
                "Content-Type": "text/plain",
                "X-Session-Deck-Action-Token": token,
            },
        )
        with self.assertRaises(HTTPError) as invalid_content_type_raised:
            urlopen(invalid_content_type, timeout=1.0)
        self.assertEqual(invalid_content_type_raised.exception.code, 415)
        invalid_content_type_payload = json.loads(
            invalid_content_type_raised.exception.read().decode("utf-8")
        )
        self.assertEqual(
            invalid_content_type_payload,
            {"ok": False, "status": "failed", "message": "Content-Type must be application/json."},
        )

        oversized_request = Request(
            f"{base_url}/actions/create-worktree",
            data=b"x" * (AUTO.ACTION_BODY_LIMIT_BYTES + 1),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Session-Deck-Action-Token": token,
            },
        )
        with self.assertRaises(HTTPError) as oversized_request_raised:
            urlopen(oversized_request, timeout=1.0)
        self.assertEqual(oversized_request_raised.exception.code, 413)
        oversized_payload = json.loads(oversized_request_raised.exception.read().decode("utf-8"))
        self.assertEqual(
            oversized_payload,
            {"ok": False, "status": "failed", "message": "Request body is empty or too large."},
        )


class BridgeRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        sys.modules.pop("iterm2", None)

    async def start_bridge(
        self,
        fixture: TempRuntime,
        connection: FakeConnection | None = None,
        effective_command_path=None,
    ):
        connection = connection or FakeConnection()
        effective_command_path = effective_command_path or make_effective_command_path()
        install_fake_iterm2(make_fake_iterm2(connection))
        bridge = await AUTO.start_bridge_server(
            fixture.config(), connection, asyncio.Lock(), effective_command_path
        )
        self.addAsyncCleanup(bridge.close)
        return bridge, connection

    async def test_bridge_accepts_ping_and_rejects_multiple_or_oversized_operations(self):
        fixture = TempRuntime(self)
        bridge, _connection = await self.start_bridge(fixture)

        ping = await unix_json_request(bridge.socket_path, b'{"ping":true}\n')
        self.assertEqual(ping, {"ok": True, "message": "pong"})

        multiple = await unix_json_request(
            bridge.socket_path, b'{"ping":true,"itermSessionId":"w0t0p0:abc"}\n'
        )
        self.assertFalse(multiple["ok"])
        self.assertIn("exactly one operation", multiple["message"])

        extra = await unix_json_request(bridge.socket_path, b'{"ping":true,"extra":1}\n')
        self.assertFalse(extra["ok"])
        self.assertIn("only one operation", extra["message"])

        malformed = await unix_json_request(bridge.socket_path, b'{"ping":true,,}\n')
        self.assertFalse(malformed["ok"])
        self.assertIn("Malformed JSON", malformed["message"])

        too_large = await unix_json_request(
            bridge.socket_path, b'{"ping":"' + (b"x" * (AUTO.MAX_REQUEST_BYTES + 8)) + b'"}\n'
        )
        self.assertFalse(too_large["ok"])
        self.assertIn("large", too_large["message"])

    async def test_bridge_reports_live_launch_prereqs_from_the_effective_path(self):
        fixture = TempRuntime(self)
        effective_command_path = make_effective_command_path(
            "/bridge/effective/bin:/usr/bin",
            "configured login shell (/bin/zsh)",
        )
        which_calls = []

        def fake_which(command, path=None):
            which_calls.append((command, path))
            if command == "tmux":
                return "/bridge/effective/bin/tmux"
            return None

        with mock.patch.object(AUTO.shutil, "which", side_effect=fake_which):
            bridge, _connection = await self.start_bridge(
                fixture,
                effective_command_path=effective_command_path,
            )
            result = await unix_json_request(bridge.socket_path, b'{"launchPrereqs":true}\n')

        self.assertEqual(which_calls, [("tmux", effective_command_path.value), ("pi", effective_command_path.value)])
        self.assertEqual(
            result,
            {
                "ok": True,
                "message": "Reported launch prerequisites.",
                "launchPrereqs": {
                    "pathProvenance": effective_command_path.provenance,
                    "tmux": {"status": "available", "path": "/bridge/effective/bin/tmux"},
                    "pi": {"status": "missing"},
                },
            },
        )
        self.assertNotIn(effective_command_path.value, json.dumps(result))

    async def test_bridge_serializes_tmux_ui_mutations(self):
        fixture = TempRuntime(self)
        effective_command_path = make_effective_command_path("/bridge/effective/bin:/usr/bin")
        bridge, connection = await self.start_bridge(
            fixture, effective_command_path=effective_command_path
        )
        payload = (json.dumps({"tmuxAttachArgv": VALID_TMUX_ATTACH_ARGV}) + "\n").encode("utf-8")
        which_calls = []

        def fake_which(command, path=None):
            which_calls.append((command, path))
            if command == "tmux":
                return "/bridge/effective/bin/tmux"
            return None

        with mock.patch.object(AUTO.shutil, "which", side_effect=fake_which):
            first, second = await asyncio.gather(
                unix_json_request(bridge.socket_path, payload),
                unix_json_request(bridge.socket_path, payload),
            )

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(connection.max_active_tab_creations, 1)
        self.assertEqual(which_calls, [("tmux", effective_command_path.value)] * 2)
        self.assertEqual(
            connection.commands,
            [
                "/bridge/effective/bin/tmux -S '/tmp/tmux socket/default' attach-session -E -t '$1'"
            ]
            * 2,
        )
        self.assertTrue(all(not command.startswith("exec ") for command in connection.commands))

    async def test_bridge_returns_soft_failure_when_tmux_is_missing_from_effective_path(self):
        fixture = TempRuntime(self)
        effective_command_path = make_effective_command_path("/bridge/effective/bin:/usr/bin")
        bridge, connection = await self.start_bridge(
            fixture, effective_command_path=effective_command_path
        )
        payload = (json.dumps({"tmuxAttachArgv": VALID_TMUX_ATTACH_ARGV}) + "\n").encode("utf-8")

        with mock.patch.object(AUTO.shutil, "which", return_value=None) as which:
            result = await unix_json_request(bridge.socket_path, payload)

        which.assert_called_once_with("tmux", path=effective_command_path.value)
        self.assertEqual(
            result,
            {
                "ok": False,
                "reason": "open-failed",
                "message": "Failed to request iTerm2 focus: Could not resolve tmux on the effective command PATH.",
            },
        )
        self.assertEqual(connection.commands, [])
        self.assertEqual(connection.events, [])

    async def test_bridge_reuses_existing_focus_behavior(self):
        fixture = TempRuntime(self)
        bridge, connection = await self.start_bridge(fixture)
        session = FakeSession(connection, connection.app.current_terminal_window.current_tab)
        connection.app.sessions["abc"] = session

        result = await unix_json_request(bridge.socket_path, b'{"itermSessionId":"w0t0p0:abc"}\n')

        self.assertTrue(result["ok"])
        self.assertTrue(session.activated)
        self.assertEqual(
            connection.events,
            ["app.activate", "window.activate", "tab.select", "session.activate"],
        )

    async def test_bridge_rejects_invalid_tmux_argv_without_ui_mutation(self):
        fixture = TempRuntime(self)
        bridge, connection = await self.start_bridge(fixture)
        invalid = ["tmux", "-L", "bad/name", "attach-session", "-E", "-t", "prod"]
        payload = (json.dumps({"tmuxAttachArgv": invalid}) + "\n").encode("utf-8")

        result = await unix_json_request(bridge.socket_path, payload)

        self.assertFalse(result["ok"])
        self.assertIn("exact tmux attach argv", result["message"])
        self.assertEqual(connection.commands, [])

    async def test_socket_startup_handles_stale_active_non_socket_and_secure_parent(self):
        fixture = TempRuntime(self)
        fixture.socket_path.parent.mkdir(mode=0o777, parents=True, exist_ok=True)
        os.chmod(fixture.socket_path.parent, 0o777)
        stale = bind_unix_socket(fixture.socket_path)
        stale.close()

        bridge, _connection = await self.start_bridge(fixture)
        mode = stat.S_IMODE(fixture.socket_path.parent.lstat().st_mode)
        self.assertEqual(mode & 0o077, 0)
        await bridge.close()
        self.assertFalse(fixture.socket_path.exists())

        fixture.socket_path.write_text("not a socket", encoding="utf-8")
        with self.assertRaisesRegex(AUTO.StartupError, "not a socket"):
            await AUTO.start_bridge_server(
                fixture.config(), FakeConnection(), asyncio.Lock(), make_effective_command_path()
            )
        fixture.socket_path.unlink()

        active = bind_unix_socket(fixture.socket_path)
        try:
            with self.assertRaisesRegex(AUTO.StartupError, "already active"):
                await AUTO.start_bridge_server(
                    fixture.config(), FakeConnection(), asyncio.Lock(), make_effective_command_path()
                )
        finally:
            active.close()
            fixture.socket_path.unlink(missing_ok=True)

    async def test_cleanup_unlinks_only_the_socket_inode_created_by_this_process(self):
        fixture = TempRuntime(self)
        bridge, _connection = await self.start_bridge(fixture)
        original_inode = fixture.socket_path.lstat().st_ino
        fixture.socket_path.unlink()
        replacement = bind_unix_socket(fixture.socket_path)
        replacement_inode = fixture.socket_path.lstat().st_ino
        self.assertNotEqual(original_inode, replacement_inode)

        try:
            await bridge.close()
            self.assertTrue(fixture.socket_path.exists())
        finally:
            replacement.close()
            fixture.socket_path.unlink(missing_ok=True)

    async def test_register_failure_cleans_partial_startup(self):
        fixture = TempRuntime(self)
        effective_command_path = make_effective_command_path()

        async def fail_register(**_kwargs):
            raise RuntimeError("register failed")

        install_fake_iterm2(types.SimpleNamespace(tool=types.SimpleNamespace(async_register_web_view_tool=fail_register)))

        with mock.patch.object(
            AUTO,
            "resolve_effective_command_path",
            return_value=effective_command_path,
        ) as resolve_effective_command_path:
            with self.assertRaisesRegex(RuntimeError, "register failed"):
                await AUTO.start_runtime(FakeConnection(), fixture.state_path)

        resolve_effective_command_path.assert_called_once_with()
        self.assertFalse(fixture.socket_path.exists())

    async def test_start_runtime_resolves_effective_path_once_and_threads_it_to_servers(self):
        fixture = TempRuntime(self)
        effective_command_path = make_effective_command_path("/runtime/effective/bin:/usr/bin")
        captured = {}

        class FakeHttpRuntime:
            def close(self):
                captured["http_closed"] = True

        class FakeBridgeRuntime:
            async def close(self):
                captured["bridge_closed"] = True

        def fake_start_http_server(config, received_effective_command_path):
            captured["http_config"] = config
            captured["http_effective_command_path"] = received_effective_command_path
            return FakeHttpRuntime()

        async def fake_start_bridge_server(
            config,
            connection,
            ui_lock,
            received_effective_command_path,
        ):
            captured["bridge_config"] = config
            captured["bridge_connection"] = connection
            captured["bridge_ui_lock"] = ui_lock
            captured["bridge_effective_command_path"] = received_effective_command_path
            return FakeBridgeRuntime()

        async def fake_register_toolbelt(connection, http, config):
            captured["register_args"] = (connection, http, config)

        connection = FakeConnection()
        with (
            mock.patch.object(
                AUTO,
                "resolve_effective_command_path",
                return_value=effective_command_path,
            ) as resolve_effective_command_path,
            mock.patch.object(AUTO, "start_http_server", side_effect=fake_start_http_server),
            mock.patch.object(AUTO, "start_bridge_server", side_effect=fake_start_bridge_server),
            mock.patch.object(AUTO, "register_toolbelt", side_effect=fake_register_toolbelt),
        ):
            runtime = await AUTO.start_runtime(connection, fixture.state_path)

        resolve_effective_command_path.assert_called_once_with()
        self.assertIs(captured["http_effective_command_path"], effective_command_path)
        self.assertIs(captured["bridge_effective_command_path"], effective_command_path)
        self.assertIs(captured["bridge_connection"], connection)
        self.assertEqual(captured["register_args"], (connection, runtime.http, runtime.config))
        await runtime.close()
        self.assertTrue(captured["bridge_closed"])
        self.assertTrue(captured["http_closed"])


if __name__ == "__main__":
    unittest.main()
