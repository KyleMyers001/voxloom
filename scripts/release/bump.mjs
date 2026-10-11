#!/usr/bin/env node
/* global console, process */
// Bump the version in every manifest, commit, and create a vX.Y.Z tag.
// Usage: npm run release:bump -- 0.2.0 [--no-git]
// Push afterwards with: git push && git push origin vX.Y.Z
import { execFileSync } from 'node:child_process';
import { readVersions, ROOT, SEMVER, writeVersion } from './versions.mjs';

const args = process.argv.slice(2);
const version = args.find((arg) => !arg.startsWith('--'))?.replace(/^v/, '');
const noGit = args.includes('--no-git');

if (!version || !SEMVER.test(version)) {
  console.error('usage: npm run release:bump -- <x.y.z> [--no-git]');
  process.exit(2);
}

const git = (...gitArgs) =>
  execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();

if (!noGit && git('status', '--porcelain') !== '') {
  console.error('error: working tree is not clean; commit or stash first');
  process.exit(1);
}

const before = readVersions()['package.json'];
writeVersion(version);
console.log(`version ${before} -> ${version}`);

if (!noGit) {
  git(
    'add',
    'package.json',
    'package-lock.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
  );
  git('commit', '-m', `chore(release): v${version}`);
  git('tag', '-a', `v${version}`, '-m', `Voxloom v${version}`);
  console.log(`created commit and tag v${version}`);
  console.log(`next: git push && git push origin v${version}`);
}
