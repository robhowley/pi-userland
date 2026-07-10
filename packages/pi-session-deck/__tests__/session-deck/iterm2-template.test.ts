import { describe, expect, it } from 'vitest';
import { renderSessionDeckIterm2PythonScript } from '../../extensions/session-deck/iterm2/python-template.js';

describe('session-deck iterm2 python template', () => {
  it('renders a stdlib-only read-only bridge with baked runtime paths', () => {
    const script = renderSessionDeckIterm2PythonScript({
      helperScriptPath: '/tmp/session-deck/dist/extensions/session-deck/iterm2/snapshot-cli.js',
      nodeExecutablePath: '/opt/homebrew/bin/node',
      packageVersion: '1.2.3',
      webRootPath: '/tmp/session-deck/extensions/session-deck/iterm2/web',
    });

    expect(script).toContain('#!/usr/bin/env python3');
    expect(script).toContain('import json');
    expect(script).toContain('from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer');
    expect(script).toContain('import iterm2');
    expect(script).toContain('HOST = "127.0.0.1"');
    expect(script).toContain('NODE_EXECUTABLE = "/opt/homebrew/bin/node"');
    expect(script).toContain(
      'SNAPSHOT_HELPER_PATH = "/tmp/session-deck/dist/extensions/session-deck/iterm2/snapshot-cli.js"',
    );
    expect(script).toContain('WEB_ROOT = "/tmp/session-deck/extensions/session-deck/iterm2/web"');
    expect(script).toContain('PACKAGE_VERSION = "1.2.3"');
    expect(script).toContain('capture_output=True');
    expect(script).toContain('timeout=10');
    expect(script).toContain('ThreadingHTTPServer((HOST, 0), SessionDeckToolbeltHandler)');
    expect(script).toContain('if pathname == "/snapshot.json":');
    expect(script).toContain('if pathname == "/healthz":');
    expect(script).toContain('".js": "text/javascript; charset=utf-8"');
    expect(script).toContain('reveal_if_already_registered=True');
    expect(script).toContain('async_register_web_view_tool(');
    expect(script).toContain('iterm2.run_forever(main)');
    expect(script).toContain('SNAPSHOT_ERROR_CODE = "toolbelt_snapshot_unavailable"');
    expect(script).not.toContain('do_POST');
    expect(script).not.toContain('requests.');
    expect(script).not.toContain('flask');
  });
});
