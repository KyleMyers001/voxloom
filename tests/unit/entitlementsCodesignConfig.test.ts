import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('entitlements codesign config', () => {
  it('forces Tauri ad-hoc signingIdentity so entitlements are applied', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      identifier: string;
      bundle: {
        macOS: {
          entitlements: string;
          hardenedRuntime: boolean;
          signingIdentity: string | null;
          infoPlist: string;
        };
      };
    };

    // Without signingIdentity, tauri-bundler skips codesign entirely and the
    // Mach-O stays linker-signed with no embedded entitlements (Mac smoke).
    // Pseudo-identity "-" triggers codesign -s - with --entitlements.
    expect(conf.bundle.macOS.signingIdentity).toBe('-');
    expect(conf.bundle.macOS.entitlements).toBe('Entitlements.plist');
    expect(conf.bundle.macOS.hardenedRuntime).toBe(true);
    expect(conf.bundle.macOS.infoPlist).toBe('Info.plist');
    expect(conf.identifier).toBe('com.voxloom.prototype');

    expect(existsSync(resolve(root, 'src-tauri/Entitlements.plist'))).toBe(
      true,
    );
    expect(existsSync(resolve(root, 'scripts/macos-assert-entitlements.sh'))).toBe(
      true,
    );
  });

  it('keeps audio-input entitlement in Entitlements.plist only', () => {
    const entitlements = read('src-tauri/Entitlements.plist');
    expect(entitlements).toContain(
      '<key>com.apple.security.device.audio-input</key>',
    );
    expect(entitlements).toContain('<true/>');
    expect(entitlements).not.toContain('NSMicrophoneUsageDescription');

    const info = read('src-tauri/Info.plist');
    expect(info).toContain('NSMicrophoneUsageDescription');
    expect(info).not.toContain('com.apple.security.device.audio-input');
  });

  it('documents Mac verification via macos:assert-entitlements script', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['macos:assert-entitlements']).toBe(
      'bash scripts/macos-assert-entitlements.sh',
    );

    const script = read('scripts/macos-assert-entitlements.sh');
    expect(script).toContain('codesign -d --entitlements :-');
    expect(script).toContain('com.apple.security.device.audio-input');
    expect(script).toContain('--identifier');
    expect(script).toContain('com.voxloom.prototype');
    expect(script).toContain('--repair');
  });
});
