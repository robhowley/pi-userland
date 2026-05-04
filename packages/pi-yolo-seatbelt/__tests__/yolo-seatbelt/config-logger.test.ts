import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, getConfigPath, loadConfig } from '../../extensions/yolo-seatbelt/config.js';
import { logDecision } from '../../extensions/yolo-seatbelt/logger.js';
import { RuleSeverity } from '../../extensions/yolo-seatbelt/rules';

describe('config', () => {
  describe('getConfigPath', () => {
    it('returns path to config file', () => {
      const configPath = getConfigPath();
      expect(configPath).toContain('.pi');
      expect(configPath).toContain('yolo-seatbelt.json');
    });
  });

  it('returns default config when file does not exist', () => {
    // Test with a non-existent path (default case)
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe('logger', () => {
  describe('logDecision', () => {
    it('does not log when logLevel is none', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'block-rm-rf-root', { logLevel: 'none' });
      logDecision(RuleSeverity.ASK, 'find . -delete', 'ask-find-delete', { logLevel: 'none' });
      
      expect(consoleWarn).not.toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it('logs BLOCK and ASK when logLevel is warn', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'block-rm-rf-root', { logLevel: 'warn' });
      expect(consoleWarn).toHaveBeenCalledWith('[seatbelt] BLOCK: rm -rf / (rule: block-rm-rf-root)');
      
      logDecision(RuleSeverity.ASK, 'find . -delete', 'ask-find-delete', { logLevel: 'warn' });
      expect(consoleWarn).toHaveBeenCalledWith('[seatbelt] ASK: find . -delete (rule: ask-find-delete)');
      
      logDecision(RuleSeverity.ALLOW, 'echo hello', 'allow-default', { logLevel: 'warn' });
      expect(consoleWarn).not.toHaveBeenCalledWith('[seatbelt] ALLOW: echo hello');
      
      consoleWarn.mockRestore();
    });

    it('logs all decisions when logLevel is debug', () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logDecision(RuleSeverity.BLOCK, 'rm -rf /', 'block-rm-rf-root', { logLevel: 'debug' });
      expect(consoleLog).toHaveBeenCalledWith('[seatbelt] BLOCK: rm -rf / (rule: block-rm-rf-root)');
      
      logDecision(RuleSeverity.ASK, 'find . -delete', 'ask-find-delete', { logLevel: 'debug' });
      expect(consoleLog).toHaveBeenCalledWith('[seatbelt] ASK: find . -delete (rule: ask-find-delete)');
      
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
