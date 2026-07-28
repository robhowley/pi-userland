import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type TauriConfig = {
  app: {
    windows: Array<{
      title: string;
      theme?: string;
    }>;
  };
};

const TAURI_CONFIG_PATH = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url));

describe('Tauri window configuration', () => {
  it('keeps the Session Deck title and uses a dark native appearance', () => {
    const config = JSON.parse(readFileSync(TAURI_CONFIG_PATH, 'utf8')) as TauriConfig;
    const [mainWindow] = config.app.windows;

    expect(mainWindow).toMatchObject({
      title: 'Session Deck',
      theme: 'Dark',
    });
  });
});
