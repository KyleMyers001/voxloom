#!/usr/bin/env node
/* global console, process */
// Fail unless every manifest has the same version (and it matches the tag, if given).
// Usage: node scripts/release/check-version.mjs [vX.Y.Z]
import { readVersions, SEMVER } from './versions.mjs';

const tag = process.argv[2];
const versions = readVersions();
const unique = new Set(Object.values(versions));
const errors = [];

for (const [file, version] of Object.entries(versions)) {
  if (!version || !SEMVER.test(version)) {
    errors.push(`${file}: missing or invalid version "${version}"`);
  }
}
if (unique.size !== 1) {
  errors.push(`manifest versions differ: ${JSON.stringify(versions)}`);
}
if (tag) {
  const expected = tag.replace(/^refs\/tags\//, '').replace(/^v/, '');
  for (const [file, version] of Object.entries(versions)) {
    if (version !== expected) {
      errors.push(`${file}: ${version} does not match tag ${tag}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log(`OK: version ${[...unique][0]}${tag ? ` matches ${tag}` : ''}`);
