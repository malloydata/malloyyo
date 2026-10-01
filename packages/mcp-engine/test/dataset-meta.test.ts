// A dataset's NAME is its identity — a slug, the URL, what a role is granted
// against. Its TITLE is presentation. Pinned here because the two are easy to
// conflate, and conflating them in the Roles UI grants access to the wrong one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetTitle, readDatasetMeta, titleFromName } from '../src/dataset-meta';

test('a title is derived from the name when none is declared', () => {
  // So every dataset that exists today reads better without being touched.
  assert.equal(titleFromName('hub_spot'), 'Hub Spot');
  assert.equal(titleFromName('the_look'), 'The Look');
  assert.equal(titleFromName('auto_recalls'), 'Auto Recalls');
  // A hyphenated directory slugifies to underscores before it gets here.
  assert.equal(titleFromName('the-look'), 'The Look');
  assert.equal(titleFromName('sales'), 'Sales');
});

test('…and the derived one is mechanical, which is what the tag is for', () => {
  // Honest about the limit rather than clever: an acronym comes out wrong, and
  // `## dataset { title= }` is how you fix it.
  assert.equal(titleFromName('imdb'), 'Imdb');
  assert.equal(datasetTitle('imdb', 'IMDb'), 'IMDb');
});

test('a declared title wins; blank and missing both fall back', () => {
  assert.equal(datasetTitle('hub_spot', 'HubSpot CRM'), 'HubSpot CRM');
  assert.equal(datasetTitle('hub_spot', null), 'Hub Spot');
  assert.equal(datasetTitle('hub_spot', undefined), 'Hub Spot');
  assert.equal(datasetTitle('hub_spot', '   '), 'Hub Spot', 'whitespace is not a title');
});

test('readDatasetMeta: the tag, and nothing when there is none', () => {
  const tagged = {
    annotations: {
      parseAsTag: () => ({
        tag: {
          has: (k: string) => k === 'dataset',
          tag: (k: string) => (k === 'dataset' ? { has: () => false, text: () => 'HubSpot CRM', tag: () => undefined } : undefined),
          text: () => undefined,
        },
      }),
    },
  };
  assert.deepEqual(readDatasetMeta(tagged), { title: 'HubSpot CRM' });

  const bare = { annotations: { parseAsTag: () => ({ tag: { has: () => false, text: () => undefined, tag: () => undefined } }) } };
  assert.deepEqual(readDatasetMeta(bare), {});
});

test('an unparseable annotation is not a failure', () => {
  // A compile that worked must not be undone by a tag we could not read.
  const broken = { annotations: { parseAsTag: () => { throw new Error('bad tag'); } } };
  assert.deepEqual(readDatasetMeta(broken), {});
});
