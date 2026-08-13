/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * The retry ladder.
 *
 * There was no retry at all. A single 429 or a one-off 503 went straight to the
 * user as a red "Try again", and during a live demo on 2026-08-10 that happened
 * three or four times in a row — every one of them a transient provider hiccup
 * that half a second of waiting would have absorbed.
 *
 * The delays ARE the behaviour, so they are pinned here. A ladder that waits the
 * wrong amount is indistinguishable from one that works, right up until a demo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { retryDelayMs } = require('./openrouter.adapter');

test('backoff grows, and stops growing', () => {
  assert.equal(retryDelayMs(1), 500);
  assert.equal(retryDelayMs(2), 1000);
  assert.equal(retryDelayMs(3), 2000);
  assert.equal(retryDelayMs(9), 4000, 'capped rather than doubling forever');
});

test('Retry-After is obeyed when the provider states one', () => {
  assert.equal(retryDelayMs(1, '2'), 2000);
});

test('an absurd Retry-After is capped rather than obeyed', () => {
  // A provider asking for five minutes in the middle of a demo is not something
  // to sit and wait for silently.
  assert.equal(retryDelayMs(1, '300'), 8000);
});

test('a junk Retry-After falls back to the ladder', () => {
  assert.equal(retryDelayMs(2, 'soon'), 1000);
  assert.equal(retryDelayMs(2, ''), 1000);
  assert.equal(retryDelayMs(2, '-5'), 1000);
});
