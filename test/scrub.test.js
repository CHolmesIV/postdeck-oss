// Plain node:test unit tests for the mechanical hard-rules scrub.
// Run with: node --test test/scrub.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, scrubDrafts, scrubEmDashes, scrubBannedWords } from '../src/scrub.js';

test('scrubEmDashes replaces spaced em dash with comma', () => {
  const { text, changed } = scrubEmDashes('Great work — really.');
  assert.equal(text, 'Great work, really.');
  assert.equal(changed, true);
});

test('scrubEmDashes replaces unspaced em dash with " - "', () => {
  const { text, changed } = scrubEmDashes('word—word');
  assert.equal(text, 'word - word');
  assert.equal(changed, true);
});

test('scrubEmDashes handles en dash too', () => {
  const { text } = scrubEmDashes('one – two');
  assert.equal(text, 'one, two');
});

test('scrubEmDashes leaves normal hyphens alone', () => {
  const { text, changed } = scrubEmDashes('well-known fact');
  assert.equal(text, 'well-known fact');
  assert.equal(changed, false);
});

test('scrubBannedWords removes whole-word matches case-insensitively', () => {
  const { text, hit } = scrubBannedWords('This is Synergy and synergy again.', ['synergy']);
  assert.equal(hit.length, 1);
  assert.ok(!/synergy/i.test(text));
});

test('scrubText applies no_em_dash rule', () => {
  const { text, applied } = scrubText('CB said — do it.', { no_em_dash: true });
  assert.equal(text, 'CB said, do it.');
  assert.deepEqual(applied, ['no_em_dash']);
});

test('scrubText applies banned_words rule', () => {
  const { text, applied } = scrubText('Leverage synergy for growth.', {
    banned_words: ['synergy'],
  });
  assert.ok(!/synergy/i.test(text));
  assert.deepEqual(applied, ['banned_word:synergy']);
});

test('scrubText is a no-op when no hard rules fire', () => {
  const { text, applied } = scrubText('Plain clean copy.', { no_em_dash: true });
  assert.equal(text, 'Plain clean copy.');
  assert.deepEqual(applied, []);
});

test('scrubText handles empty/non-string input safely', () => {
  assert.deepEqual(scrubText('', { no_em_dash: true }), { text: '', applied: [] });
  assert.deepEqual(scrubText(undefined, { no_em_dash: true }), { text: undefined, applied: [] });
});

test('scrubDrafts scrubs every platform and dedupes applied rules', () => {
  const { drafts, scrub_applied } = scrubDrafts(
    {
      twitter: 'Ship it — now.',
      linkedin: 'Leverage synergy — now.',
    },
    { no_em_dash: true, banned_words: ['synergy'] }
  );
  assert.equal(drafts.twitter, 'Ship it, now.');
  assert.ok(!/synergy/i.test(drafts.linkedin));
  assert.ok(scrub_applied.includes('no_em_dash'));
  assert.ok(scrub_applied.includes('banned_word:synergy'));
});
