// Inferring the instance from the working directory's malloy-config.json.
//
// Oracles: the config resolution contract `login` already obeys (one target or all
// targets sharing a URL resolves; several distinct URLs demand a name), plus the rule
// this module adds — only a target under the hosted domain may be inferred, because a
// self-hosted target's first hostname label would otherwise address some *stranger's*
// hosted instance.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferInstance, InstanceInferenceError } from '../src/cloud/infer.js';

let root: string;

function repoWith(config: unknown): string {
  const dir = mkdtempSync(join(root, 'repo-'));
  writeFileSync(join(dir, 'malloy-config.json'), JSON.stringify(config));
  return dir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cloud-infer-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('inferInstance', () => {
  test('resolves the sole hosted target to its hostname’s first label', () => {
    const dir = repoWith({
      malloyyo: {
        targets: { prod: { url: 'https://walkthrough3.staging.malloyyo.com', dataset: 'orders' } },
      },
    });

    assert.deepEqual(inferInstance(dir), { slug: 'walkthrough3', targetName: 'prod' });
  });

  test('refuses a self-hosted target by naming the host, never guessing a slug', () => {
    // The hazard case: extracting "data" here would address an unrelated hosted
    // instance that happens to be called data.
    const dir = repoWith({
      malloyyo: { targets: { prod: { url: 'https://data.acme-corp.com', dataset: 'orders' } } },
    });

    assert.throws(
      () => inferInstance(dir),
      (error: unknown) =>
        error instanceof InstanceInferenceError && /data\.acme-corp\.com/.test(error.message),
    );
  });

  test('refuses an ambiguous config with the same wording login uses', () => {
    const dir = repoWith({
      malloyyo: {
        targets: {
          a: { url: 'https://one.malloyyo.com', dataset: 'x' },
          b: { url: 'https://two.malloyyo.com', dataset: 'y' },
        },
      },
    });

    assert.throws(
      () => inferInstance(dir),
      (error: unknown) => error instanceof InstanceInferenceError && /specify which/.test(error.message),
    );
  });

  test('refuses a directory with no config at all', () => {
    const dir = mkdtempSync(join(root, 'empty-'));
    mkdirSync(dir, { recursive: true });

    assert.throws(
      () => inferInstance(dir),
      (error: unknown) => error instanceof InstanceInferenceError,
    );
  });
});
