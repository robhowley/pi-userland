import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfig,
} from '../../extensions/yolo-seatbelt/config.js';
import { logDecision } from '../../extensions/yolo-seatbelt/logger.js';
import { RuleSeverity } from '../../extensions/yolo-seatbelt/rules';

const temporaryDirectories: string[] = [];

function makeConfigPath(content?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-yolo-seatbelt-'));
  temporaryDirectories.push(directory);

  const configPath = join(directory, 'yolo-seatbelt.json');
  if (content !== undefined) {
    writeFileSync(configPath, content);
  }
  return configPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('config', () => {
  describe('getConfigPath', () => {
    it('returns path to config file', () => {
      const configPath = getConfigPath();
      expect(configPath).toContain('.pi');
      expect(configPath).toContain('yolo-seatbelt.json');
    });
  });

  it('returns default config when file does not exist', () => {
    expect(loadConfig(makeConfigPath())).toEqual(DEFAULT_CONFIG);
  });

  it('returns default config for malformed JSON', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(loadConfig(makeConfigPath('{ malformed'))).toEqual(DEFAULT_CONFIG);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('[seatbelt] Failed to load config from'),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it.each([
    ['valid list', { blockedTools: ['slack_post', 'bash'] }, ['slack_post', 'bash']],
    ['missing field', {}, []],
    ['string', { blockedTools: 'slack_post' }, []],
    ['object', { blockedTools: { name: 'bash' } }, []],
    ['number', { blockedTools: 7 }, []],
    ['null', { blockedTools: null }, []],
    ['mixed list', { blockedTools: ['slack_post', 7] }, []],
  ])('normalizes a %s blockedTools value', (_description, userConfig, blockedTools) => {
    const config = loadConfig(makeConfigPath(JSON.stringify(userConfig)));

    expect(config.blockedTools).toEqual(blockedTools);
  });

  it('preserves valid settings when blockedTools is invalid', () => {
    const config = loadConfig(
      makeConfigPath(
        JSON.stringify({
          blockedTools: ['slack_post', 7],
          logLevel: 'debug',
          rules: { 'git.push-force': 'allow' },
        }),
      ),
    );

    expect(config).toMatchObject({
      blockedTools: [],
      logLevel: 'debug',
      rules: { 'git.push-force': 'allow' },
    });
  });
});

describe('logger', () => {
  describe('logDecision', () => {
    it('does not log when logLevel is none', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'rm-rf-root', { logLevel: 'none' });
      logDecision(RuleSeverity.ASK, 'find . -delete', 'find-delete', { logLevel: 'none' });

      expect(consoleWarn).not.toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it('logs BLOCK and ASK when logLevel is warn', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'rm-rf-root', { logLevel: 'warn' });
      expect(consoleWarn).toHaveBeenCalledWith('[seatbelt] BLOCK: rm -rf / (rule: rm-rf-root)');

      logDecision(RuleSeverity.ASK, 'find . -delete', 'find-delete', { logLevel: 'warn' });
      expect(consoleWarn).toHaveBeenCalledWith('[seatbelt] ASK: find . -delete (rule: find-delete)');

      logDecision(RuleSeverity.ALLOW, 'echo hello', 'allow-default', { logLevel: 'warn' });
      expect(consoleWarn).not.toHaveBeenCalledWith('[seatbelt] ALLOW: echo hello');

      consoleWarn.mockRestore();
    });

    it('logs all decisions when logLevel is debug', () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'rm-rf-root', { logLevel: 'debug' });
      expect(consoleLog).toHaveBeenCalledWith('[seatbelt] BLOCK: rm -rf / (rule: rm-rf-root)');

      logDecision(RuleSeverity.ASK, 'find . -delete', 'find-delete', { logLevel: 'debug' });
      expect(consoleLog).toHaveBeenCalledWith('[seatbelt] ASK: find . -delete (rule: find-delete)');

      logDecision(RuleSeverity.ALLOW, 'echo hello', 'allow-default', { logLevel: 'debug' });
      expect(consoleLog).toHaveBeenCalledWith('[seatbelt] ALLOW: echo hello (rule: allow-default)');

      consoleLog.mockRestore();
    });
  });

  describe('logBlock', () => {
    it('logs blocked commands', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'Command matches forbidden pattern', { logLevel: 'warn' });
      expect(consoleWarn).toHaveBeenCalledWith('[seatbelt] BLOCK: rm -rf / (rule: Command matches forbidden pattern)');

      consoleWarn.mockRestore();
    });
  });

  describe('logAsk', () => {
    it('logs asked commands', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logDecision(RuleSeverity.ASK, 'find . -delete', 'find-delete', { logLevel: 'warn' });
      expect(consoleWarn).toHaveBeenCalledWith('[seatbelt] ASK: find . -delete (rule: find-delete)');

      consoleWarn.mockRestore();
    });
  });
});
