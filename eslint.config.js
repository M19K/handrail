/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — lint.
 *
 * Added late, so it is deliberately narrow: rules that catch a real defect, and
 * nothing that argues about style. A linter that reports 400 formatting
 * opinions on its first run gets switched off, and then it catches nothing.
 *
 * The three process kinds have genuinely different globals, so they are
 * configured separately rather than unioned — `document` being defined in main
 * would hide a real bug, since main has no DOM.
 */

const globals = require('globals');

/** Rules worth failing over, in any process. */
const correctness = {
  'no-unused-vars': ['error', {
    // Caught-but-ignored errors are a deliberate pattern here: several call
    // sites treat a non-zero exit as the ordinary "nothing matched" case.
    caughtErrors: 'none',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    // `const { keyHint, ...rest } = patch` is how store.js DROPS a field it
    // must never accept back from the renderer. The binding is meant to be
    // unused; that is the whole point of writing it.
    ignoreRestSiblings: true,
  }],
  'no-undef': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  // 'except-parens', not 'always': `while ((m = re.exec(s)) !== null)` is the
  // canonical exec idiom and turn.js uses it correctly. Banning it outright
  // reports a defect where there is none, which is how a linter loses trust.
  'no-cond-assign': ['error', 'except-parens'],
  'no-return-assign': ['error', 'always'],
  'no-shadow-restricted-names': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  eqeqeq: ['error', 'smart'],

  // The one rule here that is about this product specifically. Model output
  // reaching innerHTML is the injection path CLAUDE.md calls out by name; the
  // transcript is built with createElement and textContent for that reason.
  'no-restricted-properties': ['error', {
    object: 'document',
    property: 'write',
    message: 'document.write is never correct here.',
  }],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.gstack/**',
    ],
  },

  // Main process, preloads, scripts, tests — Node.
  {
    files: ['main.js', 'preload*.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'spike/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: correctness,
  },

  // Renderer — browser. No `require`, no `process`.
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: correctness,
  },

  // The renderer dev harness is the exception: it is a main-process file that
  // happens to live in renderer/.
  {
    files: ['renderer/dev.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Playwright `_electron` tests are Node files that also contain renderer
  // code: the callback passed to `page.evaluate()` is serialised and run inside
  // the window, so `document` and `window` are genuinely defined there. Both
  // sets of globals apply to the same file, and neither alone is correct.
  {
    files: ['tests/qa/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
