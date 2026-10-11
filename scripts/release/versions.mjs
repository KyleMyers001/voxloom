// Read and write the app version across package.json, tauri.conf.json and Cargo.toml.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'package.json');
const LOCK = join(ROOT, 'package-lock.json');
const TAURI = join(ROOT, 'src-tauri', 'tauri.conf.json');
const CARGO = join(ROOT, 'src-tauri', 'Cargo.toml');
const CARGO_LOCK = join(ROOT, 'src-tauri', 'Cargo.lock');

// Official semver.org regex (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string).
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, data) =>
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

// Matches the `version = "..."` line inside the [package] table only.
const CARGO_PKG_VERSION = /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;

export function readVersions() {
  const cargo = readFileSync(CARGO, 'utf8').match(CARGO_PKG_VERSION);
  return {
    'package.json': readJson(PKG).version,
    'src-tauri/tauri.conf.json': readJson(TAURI).version,
    'src-tauri/Cargo.toml': cargo ? cargo[2] : undefined,
  };
}

export function writeVersion(version) {
  const pkg = readJson(PKG);
  pkg.version = version;
  writeJson(PKG, pkg);

  const lock = readJson(LOCK);
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeJson(LOCK, lock);

  const tauri = readJson(TAURI);
  tauri.version = version;
  writeJson(TAURI, tauri);

  const cargo = readFileSync(CARGO, 'utf8');
  writeFileSync(CARGO, cargo.replace(CARGO_PKG_VERSION, `$1${version}$3`));

  // Keep Cargo.lock in sync so `--locked` builds keep working.
  const cargoLock = readFileSync(CARGO_LOCK, 'utf8');
  writeFileSync(
    CARGO_LOCK,
    cargoLock.replace(
      /(\[\[package\]\]\nname = "voxloom"\nversion = ")[^"]+(")/,
      `$1${version}$2`,
    ),
  );
}
