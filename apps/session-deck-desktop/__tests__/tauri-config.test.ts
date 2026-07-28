import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

type TauriConfig = {
  app: {
    trayIcon: {
      id: string;
      iconPath: string;
      iconAsTemplate: boolean;
      tooltip: string;
      showMenuOnLeftClick: boolean;
    };
    windows: Array<{
      title: string;
      theme?: string;
    }>;
  };
  bundle: {
    icon: string[];
    targets: string[];
    macOS: {
      signingIdentity?: string;
    };
  };
};

type PngMetadata = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
};

const TAURI_ROOT = new URL('../src-tauri/', import.meta.url);
const TAURI_CONFIG_PATH = fileURLToPath(new URL('tauri.conf.json', TAURI_ROOT));
const CARGO_MANIFEST_PATH = fileURLToPath(new URL('Cargo.toml', TAURI_ROOT));
const APP_ICON_PATH = fileURLToPath(new URL('icons/icon.png', TAURI_ROOT));
const ICNS_ICON_PATH = fileURLToPath(new URL('icons/icon.icns', TAURI_ROOT));
const TRAY_ICON_PATH = fileURLToPath(new URL('icons/tray-icon.png', TAURI_ROOT));
const TRAY_SVG_PATH = fileURLToPath(new URL('icons/tray-icon.svg', TAURI_ROOT));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngMetadata(png: Buffer): PngMetadata {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  };
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodePngAlpha(png: Buffer): (x: number, y: number) => number {
  const { width, height, bitDepth, colorType } = pngMetadata(png);
  if (bitDepth !== 8 || colorType !== 6) throw new Error('Expected an 8-bit RGBA PNG');

  const idatChunks: Buffer[] = [];
  for (let offset = PNG_SIGNATURE.length; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idatChunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }

  const filtered = inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = filtered.readUInt8(inputOffset++);
    for (let x = 0; x < stride; x += 1) {
      const outputOffset = y * stride + x;
      const left = x >= 4 ? rgba.readUInt8(outputOffset - 4) : 0;
      const above = y > 0 ? rgba.readUInt8(outputOffset - stride) : 0;
      const upperLeft = x >= 4 && y > 0 ? rgba.readUInt8(outputOffset - stride - 4) : 0;
      let predictor: number;

      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = above;
          break;
        case 3:
          predictor = Math.floor((left + above) / 2);
          break;
        case 4:
          predictor = paethPredictor(left, above, upperLeft);
          break;
        default:
          throw new Error(`Unsupported PNG filter: ${filter}`);
      }

      rgba.writeUInt8((filtered.readUInt8(inputOffset++) + predictor) & 0xff, outputOffset);
    }
  }

  return (x, y) => rgba.readUInt8(y * stride + x * 4 + 3);
}

describe('Tauri configuration', () => {
  it('keeps the Session Deck title and uses a dark native appearance', () => {
    const config = JSON.parse(readFileSync(TAURI_CONFIG_PATH, 'utf8')) as TauriConfig;
    const [mainWindow] = config.app.windows;

    expect(mainWindow).toMatchObject({
      title: 'Session Deck',
      theme: 'Dark',
    });
  });

  it('configures the template tray icon without an automatic left-click menu', () => {
    const config = JSON.parse(readFileSync(TAURI_CONFIG_PATH, 'utf8')) as TauriConfig;

    expect(config.app.trayIcon).toEqual({
      id: 'session-deck',
      iconPath: 'icons/tray-icon.png',
      iconAsTemplate: true,
      tooltip: 'Session Deck',
      showMenuOnLeftClick: false,
    });
  });

  it('builds only the app with both icons and Tauri ad-hoc signing', () => {
    const config = JSON.parse(readFileSync(TAURI_CONFIG_PATH, 'utf8')) as TauriConfig;

    expect(config.bundle.targets).toEqual(['app']);
    expect(config.bundle.icon).toEqual(['icons/icon.png', 'icons/icon.icns']);
    expect(config.bundle.macOS.signingIdentity).toBe('-');
  });

  it('commits the confirmed app icon and valid macOS icon resources', () => {
    const appIcon = readFileSync(APP_ICON_PATH);
    const icnsIcon = readFileSync(ICNS_ICON_PATH);

    expect(createHash('sha256').update(appIcon).digest('hex')).toBe(
      'dce6b5ffc66207c0a53da18b170738ac67d51ca856c2ed3b855ae75306456177',
    );
    expect(pngMetadata(appIcon)).toEqual({
      width: 1024,
      height: 1024,
      bitDepth: 8,
      colorType: 6,
    });
    expect(icnsIcon.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icnsIcon.readUInt32BE(4)).toBe(icnsIcon.length);
    expect(icnsIcon.length).toBeGreaterThan(0);
  });

  it('keeps the exact tray geometry and transparent dot cutouts', () => {
    const svg = readFileSync(TRAY_SVG_PATH, 'utf8');
    const trayIcon = readFileSync(TRAY_ICON_PATH);

    expect(svg.match(/<rect x=/gu)).toHaveLength(3);
    expect(svg).toContain('<rect x="3" y="3" width="18" height="5" rx="1.4"/>');
    expect(svg).toContain('<rect x="3" y="9.5" width="18" height="5" rx="1.4"/>');
    expect(svg).toContain('<rect x="3" y="16" width="18" height="5" rx="1.4"/>');
    expect(svg.match(/<circle /gu)).toHaveLength(3);
    expect(svg).toContain('<circle cx="5.5" cy="5.5" r="1.1" fill="black"/>');
    expect(svg).toContain('<circle cx="5.5" cy="12" r="1.1" fill="black"/>');
    expect(svg).toContain('<circle cx="5.5" cy="18.5" r="1.1" fill="black"/>');
    expect(svg).toContain('<g fill="black" mask="url(#cutouts)">');

    expect(pngMetadata(trayIcon)).toEqual({ width: 36, height: 36, bitDepth: 8, colorType: 6 });
    const alphaAt = decodePngAlpha(trayIcon);
    expect({
      exterior: alphaAt(0, 0),
      holes: [alphaAt(8, 8), alphaAt(8, 18), alphaAt(8, 28)],
      rows: [alphaAt(18, 8), alphaAt(18, 18), alphaAt(18, 28)],
    }).toEqual({ exterior: 0, holes: [0, 0, 0], rows: [255, 255, 255] });
  });

  it('enables only the Tauri tray icon feature', () => {
    const cargoManifest = readFileSync(CARGO_MANIFEST_PATH, 'utf8');

    expect(cargoManifest.match(/^tauri = .*$/mu)?.[0]).toBe(
      'tauri = { version = "2", features = ["tray-icon"] }',
    );
  });
});
