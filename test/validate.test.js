// Unit tests for TikTok cosmetic-field validation (B6 polish - flagged gap
// from B3). Run with: node --test test/validate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTiktokFields, tiktokRequiredFields } from '../src/validate.js';

const TIKTOK_REQUIRED_FIELDS = tiktokRequiredFields();

const VALID_FIELDS = {
  privacyLevel: 'PUBLIC_TO_EVERYONE',
  disabledComments: false,
  disabledDuet: false,
  disabledStitch: true,
  isBrandedContent: false,
  isYourBrand: true,
  isAiGenerated: false,
};

test('validateTiktokFields passes a fully-populated fields object', () => {
  const { ok, missing } = validateTiktokFields(VALID_FIELDS);
  assert.equal(ok, true);
  assert.deepEqual(missing, []);
});

test('validateTiktokFields flags every required field when empty', () => {
  const { ok, missing } = validateTiktokFields({});
  assert.equal(ok, false);
  assert.deepEqual(missing.sort(), [...TIKTOK_REQUIRED_FIELDS].sort());
});

test('validateTiktokFields flags a single missing boolean flag', () => {
  const fields = { ...VALID_FIELDS };
  delete fields.isAiGenerated;
  const { ok, missing } = validateTiktokFields(fields);
  assert.equal(ok, false);
  assert.deepEqual(missing, ['isAiGenerated']);
});

test('validateTiktokFields rejects a non-boolean value for a boolean flag', () => {
  const fields = { ...VALID_FIELDS, disabledDuet: 'true' };
  const { ok, missing } = validateTiktokFields(fields);
  assert.equal(ok, false);
  assert.deepEqual(missing, ['disabledDuet']);
});

test('validateTiktokFields rejects an unrecognized privacyLevel', () => {
  const fields = { ...VALID_FIELDS, privacyLevel: 'EVERYONE' };
  const { ok, missing } = validateTiktokFields(fields);
  assert.equal(ok, false);
  assert.deepEqual(missing, ['privacyLevel']);
});

test('validateTiktokFields treats null/empty-string as missing', () => {
  const fields = { ...VALID_FIELDS, privacyLevel: '', isYourBrand: null };
  const { ok, missing } = validateTiktokFields(fields);
  assert.equal(ok, false);
  assert.deepEqual(missing.sort(), ['isYourBrand', 'privacyLevel']);
});
