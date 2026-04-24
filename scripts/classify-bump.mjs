#!/usr/bin/env node
/**
 * Classify a semver bump as patch/minor/major.
 *
 * Usage:  node scripts/classify-bump.js <prev> <curr>
 * Writes `kind=...`, `prev=...`, `curr=...` to $GITHUB_OUTPUT for use in
 * subsequent workflow steps (conditional announce on minor/major only).
 *
 * Accepts versions with or without a leading 'v'. Falls back to "minor"
 * if either value fails to parse — announce on uncertainty is safer than
 * silent skip for a real release.
 */
import { appendFileSync } from 'node:fs';
import { argv, env, stderr, stdout } from 'node:process';

const [, , rawPrev, rawCurr] = argv;

function strip(v) {
  return (v ?? '').trim().replace(/^v/, '');
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(strip(v));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function classify(prev, curr) {
  if (!prev || !curr) return 'minor';
  if (curr.major > prev.major) return 'major';
  if (curr.major < prev.major) return 'patch'; // rollback: treat as patch-noop
  if (curr.minor > prev.minor) return 'minor';
  if (curr.patch > prev.patch) return 'patch';
  return 'patch'; // same or lower — don't announce
}

const prev = parse(rawPrev);
const curr = parse(rawCurr);
const kind = classify(prev, curr);

const prevClean = strip(rawPrev);
const currClean = strip(rawCurr);

const out = `kind=${kind}\nprev=${prevClean}\ncurr=${currClean}\n`;

if (env.GITHUB_OUTPUT) {
  appendFileSync(env.GITHUB_OUTPUT, out);
  stderr.write(out);
} else {
  stdout.write(out);
}
