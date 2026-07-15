from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import socket
import stat
import sys
import tempfile
import types
import unittest
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
        http = AUTO.start_http_server(config)
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

        with self.assertRaises(HTTPError) as raised:
            urlopen(f"{base_url}/missing.js", timeout=1.0)
        self.assertEqual(raised.exception.code, 404)

    def test_toolbelt_create_worktree_action_requires_token_and_runs_helper(self):
        fixture = TempRuntime(self)
        helper_path = fixture.config().runtime.create_worktree_helper_path
        helper_path.parent.mkdir(parents=True)
        helper_path.write_text(
            "import json, sys\n"
            "payload = json.loads(sys.stdin.read())\n"
            "print(json.dumps({'ok': True, 'status': 'created', 'repoPath': payload['repoPath']}))\n",
            encoding="utf-8",
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()
        config = fixture.config()
        http = AUTO.start_http_server(config)
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
        helper_path = fixture.config().runtime.create_worktree_helper_path
        helper_path.parent.mkdir(parents=True)
        helper_path.write_text(
            "import json, sys\n"
            "payload = json.loads(sys.stdin.read())\n"
            "print(json.dumps({'ok': True, 'status': 'resolved', 'action': payload.get('action'), 'repoIntent': payload['repoIntent']}))\n",
            encoding="utf-8",
        )
        fixture.payload["runtime"]["nodeExecutablePath"] = sys.executable
        fixture.write_state()
        config = fixture.config()
        http = AUTO.start_http_server(config)
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


class BridgeRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        sys.modules.pop("iterm2", None)

    async def start_bridge(self, fixture: TempRuntime, connection: FakeConnection | None = None):
        connection = connection or FakeConnection()
        install_fake_iterm2(make_fake_iterm2(connection))
        bridge = await AUTO.start_bridge_server(fixture.config(), connection, asyncio.Lock())
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

    async def test_bridge_serializes_tmux_ui_mutations(self):
        fixture = TempRuntime(self)
        bridge, connection = await self.start_bridge(fixture)
        payload = (json.dumps({"tmuxAttachArgv": VALID_TMUX_ATTACH_ARGV}) + "\n").encode("utf-8")

        first, second = await asyncio.gather(
            unix_json_request(bridge.socket_path, payload),
            unix_json_request(bridge.socket_path, payload),
        )

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(connection.max_active_tab_creations, 1)
        self.assertEqual(connection.commands, ["exec tmux -S '/tmp/tmux socket/default' attach-session -E -t '$1'"] * 2)

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
            await AUTO.start_bridge_server(fixture.config(), FakeConnection(), asyncio.Lock())
        fixture.socket_path.unlink()

        active = bind_unix_socket(fixture.socket_path)
        try:
            with self.assertRaisesRegex(AUTO.StartupError, "already active"):
                await AUTO.start_bridge_server(fixture.config(), FakeConnection(), asyncio.Lock())
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

        async def fail_register(**_kwargs):
            raise RuntimeError("register failed")

        install_fake_iterm2(types.SimpleNamespace(tool=types.SimpleNamespace(async_register_web_view_tool=fail_register)))

        with self.assertRaisesRegex(RuntimeError, "register failed"):
            await AUTO.start_runtime(FakeConnection(), fixture.state_path)

        self.assertFalse(fixture.socket_path.exists())


if __name__ == "__main__":
    unittest.main()
