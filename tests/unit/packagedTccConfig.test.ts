import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('packaged-app TCC config', () => {
  it('enables a Voxloom macOS .app bundle with mic privacy keys', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      productName: string;
      identifier: string;
      bundle: {
        active: boolean;
        targets: string[];
        icon: string[];
        macOS: {
          infoPlist: string;
          entitlements: string;
          hardenedRuntime: boolean;
          signingIdentity: string | null;
        };
      };
      app: { windows: Array<{ title: string }> };
    };

    expect(conf.productName).toBe('Voxloom');
    expect(conf.identifier).toBe('com.voxloom.prototype');
    expect(conf.app.windows[0]?.title).toBe('Voxloom');
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.targets).toEqual(['app', 'dmg']);
    expect(conf.bundle.macOS.infoPlist).toBe('Info.plist');
    expect(conf.bundle.macOS.entitlements).toBe('Entitlements.plist');
    expect(conf.bundle.macOS.hardenedRuntime).toBe(true);
    // Ad-hoc "-" is required so Tauri runs codesign with Entitlements.plist
    // (see entitlementsCodesignConfig.test.ts / BUS-10-entitlements-codesign).
    expect(conf.bundle.macOS.signingIdentity).toBe('-');
    expect(conf.bundle.icon).toEqual(
      expect.arrayContaining([
        'icons/32x32.png',
        'icons/128x128.png',
        'icons/128x128@2x.png',
        'icons/icon.icns',
      ]),
    );

    for (const icon of conf.bundle.icon) {
      expect(existsSync(resolve(root, 'src-tauri', icon))).toBe(true);
    }
  });

  it('ships NSMicrophoneUsageDescription and Voxloom display names', () => {
    const plist = read('src-tauri/Info.plist');
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>');
    expect(plist).toContain('captures audio locally for transcription');
    expect(plist).toContain('<key>CFBundleDisplayName</key>');
    expect(plist).toContain('<key>CFBundleName</key>');
    expect(plist).toMatch(/<string>Voxloom<\/string>/);
  });

  it('ships hardened-runtime audio-input entitlement (not Info.plist)', () => {
    const entitlements = read('src-tauri/Entitlements.plist');
    expect(entitlements).toContain(
      '<key>com.apple.security.device.audio-input</key>',
    );
    expect(entitlements).toContain('<true/>');
    expect(entitlements).not.toContain('NSMicrophoneUsageDescription');
  });
});
