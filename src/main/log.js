/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — main-process log file.
 *
 * Exists because of a real failure. Handrail 0.1.3 shipped a macOS build that
 * started its main process, created no window, registered no hotkey and drew no
 * tray icon. From the outside it was indistinguishable from "nothing happened",
 * and there was no way to find out why: `console.log` in a packaged mac app goes
 * nowhere a user — or the person they are reporting the bug to — can reach.
 *
 * So every line main writes also lands in a file, in userData, next to the
 * settings the user is already told about. One file, truncated on every boot so
 * it can never grow without bound, and always describing the CURRENT run.
 *
 * Deliberately not a logging library and deliberately not levelled. The whole
 * job is "what happened during boot, and what went wrong", and a dependency
 * would be a bigger risk than the problem.
 */

const fs = require('fs');
const path = require('path');

/** Keep the previous run's log around — the interesting failure is often the one before. */
const KEEP_PREVIOUS = true;

let stream = null;
let filePath = null;

function stamp() {
  // Local time, not ISO/UTC. The person reading this is looking at their own
  // clock and trying to match a log line to "when I clicked the thing".
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function format(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch (_) {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * Start logging to `<userData>/handrail.log`.
 *
 * Called as early as main can manage — before anything that might throw, so a
 * crash during boot still leaves a file behind saying how far it got. Safe to
 * call twice; the second call is ignored.
 *
 * Failure to open the log must never be fatal. A read-only or full disk is not
 * a reason to refuse to run the product, so every path here swallows its own
 * error and falls back to console only.
 */
function start(dir, meta = {}) {
  if (stream) return filePath;
  try {
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, 'handrail.log');

    if (KEEP_PREVIOUS) {
      try {
        if (fs.existsSync(filePath)) fs.renameSync(filePath, path.join(dir, 'handrail.previous.log'));
      } catch (_) { /* a missing or locked previous log is not worth failing over */ }
    }

    stream = fs.createWriteStream(filePath, { flags: 'w' });
    // An EPIPE or EACCES on the stream must not take the app down with it.
    stream.on('error', () => { stream = null; });
  } catch (_) {
    stream = null;
    filePath = null;
  }

  write('log', ['--- Handrail starting ---']);
  for (const [k, v] of Object.entries(meta)) write('log', [`  ${k}:`, v]);
  return filePath;
}

function write(level, args) {
  const line = `${stamp()} ${level === 'log' ? '' : `[${level}] `}${format(args)}`;
  if (stream) {
    try {
      stream.write(`${line}\n`);
    } catch (_) { /* see above */ }
  }
}

/**
 * Mirror console.log/warn/error in the main process into the file.
 *
 * Wrapping rather than replacing: everything still goes to stdout, which is
 * what `npm start` and the smoke suite read. This only adds a second
 * destination that survives being a packaged, windowless background app.
 */
function captureConsole() {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      write(level, args);
      original(...args);
    };
  }
}

/** Where the log is, so the UI can offer to reveal it. Null if it could not be opened. */
function file() {
  return filePath;
}

module.exports = { start, captureConsole, file };
