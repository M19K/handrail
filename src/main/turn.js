/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — turn orchestration.
 *
 * A turn is the whole unit of work: capture the screen, answer or plan, point
 * at the first control, then watch until the task is finished.
 *
 * All the cost control lives here. The watching loop is the part that could
 * quietly bankrupt a user, and PRODUCT.md § Step completion is its spec:
 *
 *   local frame diff (free) -> quiet debounce (free) -> one small call -> rate cap
 *
 * A user who is reading their screen and not touching anything costs nothing.
 */

const { captureDisplay, displayForWindow, captureMatchesDisplay } = require('./capture');
const { parseBox, isBoxSane, boxToScreenRect, arrowLayout } = require('./geometry');

// --- watching parameters. See PRODUCT.md for the reasoning behind each. -----
const QUIET_MS = 1200;        // screen must be still this long before checking
const MIN_CHECK_GAP_MS = 4000; // never check more often than this
const POLL_MS = 600;          // how often we sample cheaply for movement
const CHANGE_THRESHOLD = 0.012; // fraction of sampled bytes that must differ
const MAX_FAILURES = 3;       // give up watching, surface the manual tick

class TurnController {
  /**
   * @param {object} deps
   * @param {import('./llm').Llm} deps.llm
   * @param {import('./store').Store} deps.store
   * @param {() => Electron.BrowserWindow} deps.getOverlay
   * @param {(event: object) => void} deps.emit      send on the hr:turn stream
   * @param {(rect: object|null) => void} deps.point draw or clear the arrow
   * @param {() => (() => void)} deps.excludeFromCapture keep our own windows out
   *   of the screenshot; returns a restore function
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.turnId = 0;
    this.active = null;   // { id, cancelled }
    this.task = null;     // { taskId, steps, activeIndex, display }
    this.watch = null;    // watching loop handle
    // Which thread the RENDERER has open. Main used to guess "the most recently
    // updated thread", so opening a week-old thread and asking a follow-up fed
    // the newest thread's history to the model and appended the reply there.
    this.threadId = null;
    // Bumped by anything that tears state down. Async work captures it and
    // refuses to touch state if it has moved on since — otherwise a locate()
    // that takes three seconds can draw an arrow AFTER the user has hidden
    // Handrail, which our own comments call the worst failure this product has.
    this.epoch = 0;
  }

  // --- lifecycle ----------------------------------------------------------

  /**
   * `turnId` is minted by the RENDERER and passed in, not generated here.
   *
   * If main allocated it, the id would only reach the renderer in the reply to
   * this call — and `_run` starts emitting immediately. A fast reply (a cached
   * response, a stubbed model, a fast link) beats the IPC round trip, so
   * `answer` and `done` arrive while the renderer still thinks no turn is in
   * flight, get dropped as stale, and the bar spins forever with no way to ask
   * anything else. Letting the renderer choose the id closes the window
   * entirely rather than making it small.
   */
  async ask({ text, capture, turnId, threadId }) {
    // Abort any in-flight request, but LEAVE THE TASK ALONE. This used to call
    // cancel(), which also stopped the watching loop and cleared the arrow — so
    // asking "now what?" in the middle of a task quietly abandoned it.
    this._abortRequest();
    // The renderer says which thread it has open. Only it knows — `openThread`
    // is a renderer-side action and never reached main, so main guessed.
    if (threadId !== undefined) this.threadId = threadId || null;
    const id = turnId || `turn_${++this.turnId}`;
    // A real AbortController, threaded to fetch. `cancelled` alone only made us
    // ignore the reply — a cancelled 3000-token vision call kept running and
    // stayed billed, so Escape looked like a cancel without being one.
    const turn = { id, cancelled: false, abort: new AbortController() };
    this.active = turn;

    // Fire and forget: the renderer already has the turnId and everything
    // else arrives as events. Awaiting here would block the IPC reply on the
    // whole model round-trip.
    this._run(turn, { text, capture }).catch((err) => {
      // An abort is not a failure to report — the user asked for it.
      if (turn.cancelled || (err && err.name === 'AbortError')) return;
      this.emit({ type: 'error', turnId: id, message: friendly(err), recoverable: true });
      this.emit({ type: 'done', turnId: id });
    });

    return { turnId: id };
  }

  /** Abort the in-flight model request. The task, if any, survives. */
  _abortRequest() {
    if (this.active) {
      this.active.cancelled = true;
      if (this.active.abort) this.active.abort.abort();
    }
    this.active = null;
    this.epoch += 1;
  }

  /**
   * Stop the request but keep the task running.
   *
   * This is what Escape does. Someone cancelling a slow reply mid-task has not
   * asked to throw the task away, and taking their checklist and their arrow
   * with it would be a surprising amount of destruction for one keypress.
   */
  cancel() {
    this._abortRequest();
  }

  /**
   * Put everything away: request, task, watching, arrow.
   *
   * For collapsing the overlay, starting a new thread, and quitting — the
   * cases where the user has genuinely finished with what was on screen. An
   * arrow left pointing at a control after Handrail has been put away is the
   * worst failure this product has.
   */
  reset() {
    this._abortRequest();
    this.task = null;
    this.threadId = null;
    this.stopWatching();
    this.clearArrow();
  }

  async _run(turn, { text, capture }) {
    const settings = this.store.getSettings();
    const useCapture = capture !== undefined ? capture : settings.capture;

    let shot = null;
    let display = null;

    if (useCapture) {
      display = displayForWindow(this.getOverlay());
      // Handrail is excluded from its own screenshot without anything moving
      // on screen — see windows.js § excludeFromCapture.
      const shotResult = await this._captureWithoutSelf(display, 'full');
      if (turn.cancelled) return;
      shot = shotResult.buffer;
      this.emit({ type: 'capture', turnId: turn.id });

      if (!captureMatchesDisplay(shotResult.size, display)) {
        // Not fatal — the answer is still useful, only the arrow depends on
        // the geometry. Suppress pointing rather than point somewhere wrong.
        console.warn('[turn] capture does not match display; pointing disabled for this turn');
        display = null;
      }
    }

    this.emit({ type: 'thinking', turnId: turn.id });

    const thread = this._currentThread();
    const result = await this.llm.respond({
      prompt: text,
      screenshot: shot,
      history: thread ? thread.turns : [],
      // So a follow-up continues the checklist instead of duplicating it.
      activeTask: this.task,
      signal: turn.abort && turn.abort.signal,
    });
    if (turn.cancelled) return;

    if (result.kind === 'task') {
      await this._startTask(turn, result, display, text, shot);
    } else {
      this.emit({ type: 'answer', turnId: turn.id, markdown: result.markdown });
      this.emit({ type: 'done', turnId: turn.id });
      this._record(text, { kind: 'answer', markdown: result.markdown });
      this.active = null;

      // The model could see the current step was finished. Advance the checklist
      // so it agrees with what the reply just said — and only for the step that
      // is actually current, so a stale or invented index cannot skip ahead.
      if (this.task && result.completedStep === this.task.activeIndex) {
        await this.completeStep(this.task.taskId, this.task.activeIndex);
      }

      // Point at what the answer just told them to click.
      //
      // Pointing used to be tied to checklist steps only, so an ordinary answer
      // saying "right-click the tab and choose Show in system explorer" could
      // not draw an arrow at it — which is the one thing this product does that
      // nothing else does. Reuses the screenshot already taken this turn.
      if (result.target && shot && display && this.store.getSettings().pointing) {
        await this._pointAtTarget({
          display,
          screenshot: shot,
          target: result.target,
          instruction: firstSentence(result.markdown),
        });
      }
    }
  }

  async _startTask(turn, plan, display, prompt, screenshot) {
    // A plan with nothing left in it is not a task. llm.js filters out steps
    // with no text, so a model that returns two blank steps used to arrive here
    // as an empty array and crash on steps[0] below — leaving a task object
    // with no steps assigned, which was then fed to every later prompt.
    if (!plan.steps || plan.steps.length < 1) {
      this.emit({ type: 'answer', turnId: turn.id, markdown: plan.title || 'I could not work out the steps for that.' });
      this.emit({ type: 'done', turnId: turn.id });
      this.active = null;
      return;
    }

    const taskId = `task_${turn.id}`;
    this.task = {
      taskId,
      // The title is load-bearing: llm.js quotes it back to the model to say
      // which checklist is already running. Without it every follow-up was told
      // the running checklist was called "undefined".
      title: plan.title,
      display,
      activeIndex: 0,
      failures: 0,
      steps: plan.steps.map((s) => ({ ...s, status: 'todo' })),
    };
    this.task.steps[0].status = 'active';

    this.emit({
      type: 'task',
      turnId: turn.id,
      taskId,
      title: plan.title,
      // doneWhen and target stay in main — the renderer has no use for them,
      // and shipping them across would only invite it to second-guess main.
      steps: this.task.steps.map((s) => ({ text: s.text, hint: s.hint })),
    });
    this.emit({ type: 'done', turnId: turn.id });
    this._record(prompt, {
      kind: 'task',
      title: plan.title,
      steps: plan.steps.map((s) => ({ text: s.text, hint: s.hint })),
    });
    this.active = null;

    const settings = this.store.getSettings();
    if (settings.pointing && display) await this._pointAtActiveStep(screenshot);
    if (display && settings.capture !== false) this.startWatching();
  }

  // --- arrow --------------------------------------------------------------

  /**
   * @param {Buffer} [reuse] a capture already taken this instant, if there is
   *   one. The first arrow of a task follows immediately after the turn's own
   *   screenshot, and taking a second one of the same unchanged screen is a
   *   wasted round trip — and, before capture exclusion, a second visible flash.
   */
  async _pointAtActiveStep(reuse) {
    const task = this.task;
    if (!task || !task.display) return;

    const step = task.steps[task.activeIndex];
    if (!step || !step.target) return this.clearArrow();

    await this._pointAtTarget({
      display: task.display,
      screenshot: reuse,
      target: step.target,
      instruction: step.text,
    });
  }

  /**
   * Find a named control in a screenshot and draw the arrow at it.
   *
   * Shared by checklist steps and by ordinary answers. Pointing was tied to
   * steps at first, which meant a plain reply saying "right-click the tab and
   * choose Show in system explorer" could not point at anything — and that is
   * the one thing this product does that nothing else does.
   */
  async _pointAtTarget({ display, screenshot, target, instruction }) {
    if (!display || !target) return this.clearArrow();

    // Everything below this line is asynchronous and slow — a capture plus a
    // vision call, seconds of it. During that the user can hit the panic
    // hotkey, collapse the overlay, start a new thread or quit, all of which
    // call reset() and bump the epoch. Without this token the in-flight locate
    // resolved afterwards and drew an arrow on a screen the user had already
    // put Handrail away from, which our own comments call the worst failure
    // this product has.
    const epoch = this.epoch;
    const stale = () => this.epoch !== epoch;

    try {
      let buffer = screenshot;
      if (!buffer) {
        const shot = await this._captureWithoutSelf(display, 'full');
        if (stale()) return;
        if (!captureMatchesDisplay(shot.size, display)) return this.clearArrow();
        buffer = shot.buffer;
      }

      const found = await this.llm.locate({ screenshot: buffer, target });
      if (stale()) return;
      if (!found || found.found === false) return this.clearArrow();

      const box = parseBox(found);
      // The sanity check is the guard against a model that ignored the 0-1000
      // convention and returned raw pixels — which would map the arrow several
      // screens to the right rather than erroring.
      if (!isBoxSane(box)) return this.clearArrow();

      // Pointing can also have been switched off in Settings while the locate
      // was in flight. That does not bump the epoch, so it is checked directly.
      if (!this.store.getSettings().pointing) return;

      const rect = boxToScreenRect(box, display);

      // The layout is computed here, in main, because it determines the size of
      // the window the arrow is drawn in — and only main can size a window.
      const layout = arrowLayout(rect.local, {
        width: display.bounds.width,
        height: display.bounds.height,
      });

      this.point({
        display,
        layout,
        label: found.label || target,
        instruction,
      });
      this.emit({ type: 'point', rect: rect.screen });
    } catch (err) {
      // Pointing is an enhancement. If it fails the answer still stands, so it
      // fails silently rather than turning a working reply into an error.
      console.warn('[turn] could not point:', err.message);
      if (!stale()) this.clearArrow();
    }
  }

  /**
   * Clear the arrow AND say so.
   *
   * The overlay's "Pointing at it on your screen" badge was driven by a
   * `{type:'point'}` event emitted on success only, so every failure path left
   * the badge claiming an arrow that was no longer on screen.
   */
  clearArrow() {
    this.point(null);
    this.emit({ type: 'point', rect: null });
  }

  // --- watching -----------------------------------------------------------

  startWatching() {
    this.stopWatching();
    const task = this.task;
    if (!task || !task.display) return;
    // `watching` was declared in DEFAULT_SETTINGS and had an ipc branch that
    // stopped the loop, but nothing ever read it to decide whether to start
    // one — so turning it off lasted until the next step.
    if (this.store.getSettings().watching === false) return;

    const handle = { stopped: false, lastSample: null, stillSince: 0, lastCheck: 0, busy: false };
    this.watch = handle;

    const tick = async () => {
      if (handle.stopped || !this.task || this.task !== task) return;
      handle.timer = setTimeout(tick, POLL_MS);
      if (handle.busy) return;

      try {
        handle.busy = true;
        // Excluded, like every other capture. This used to call captureDisplay
        // directly, so with stealth off the overlay was in every check frame —
        // the model judged "is this step done?" against a picture containing
        // Handrail's own answer, and the frame diff fired on Handrail's own UI
        // changing rather than the user's screen.
        const { buffer, size, matched } = await this._captureWithoutSelf(task.display, 'check');

        // The ask path validates the capture and disables pointing on a
        // mismatch. This one used to validate nothing, so a fallback match —
        // which is just "the first screen there was" — meant every step check
        // for a task on the second monitor silently judged the primary screen
        // and reported the step never finished.
        if (matched === 'fallback' || !captureMatchesDisplay(size, task.display)) {
          console.warn('[turn] watch capture is not this display; stopping watch');
          this.stopWatching();
          this.emit({
            type: 'step', taskId: task.taskId, index: task.activeIndex,
            status: 'unwatched',
          });
          return;
        }

        const sample = fingerprint(buffer);

        if (handle.lastSample === null) {
          handle.lastSample = sample;
          handle.stillSince = Date.now();
          return;
        }

        const changed = difference(handle.lastSample, sample) > CHANGE_THRESHOLD;
        handle.lastSample = sample;

        if (changed) {
          // The user is doing something. Reading a half-finished drag is worse
          // than reading nothing, so the clock restarts.
          handle.stillSince = Date.now();
          return;
        }

        const now = Date.now();
        if (now - handle.stillSince < QUIET_MS) return;
        if (now - handle.lastCheck < MIN_CHECK_GAP_MS) return;
        handle.lastCheck = now;

        await this._checkActiveStep(buffer);
      } catch (err) {
        console.warn('[turn] watch tick failed:', err.message);
      } finally {
        handle.busy = false;
      }
    };

    handle.timer = setTimeout(tick, POLL_MS);
  }

  stopWatching() {
    if (!this.watch) return;
    this.watch.stopped = true;
    clearTimeout(this.watch.timer);
    this.watch = null;
  }

  async _checkActiveStep(screenshot) {
    const task = this.task;
    if (!task) return;
    const step = task.steps[task.activeIndex];
    if (!step) return;

    const verdict = await this.llm.checkStep({
      screenshot,
      stepText: step.text,
      doneWhen: step.doneWhen,
    });

    if (!verdict) {
      // Three unreadable verdicts in a row and we stop spending money on a
      // check that is not working. Failing quietly beats nagging.
      task.failures += 1;
      if (task.failures >= MAX_FAILURES) {
        console.warn('[turn] step checks failing; stopping watch');
        this.stopWatching();
        // Say so. Silently giving up leaves a checklist that looks live but
        // will never advance, with nothing to tell the user to tick it himself.
        this.emit({
          type: 'step', taskId: task.taskId, index: task.activeIndex,
          status: 'unwatched',
        });
      }
      return;
    }
    task.failures = 0;

    switch (verdict.status) {
      case 'done':
        await this.completeStep(task.taskId, task.activeIndex);
        break;
      case 'wrong':
        step.status = 'wrong';
        this.emit({
          type: 'step', taskId: task.taskId, index: task.activeIndex,
          status: 'wrong', correction: verdict.correction || '',
        });
        break;
      case 'offplan':
        this.emit({ type: 'step', taskId: task.taskId, index: task.activeIndex, status: 'offplan' });
        this.stopWatching();
        this.clearArrow();
        break;
      default:
        break; // pending — say nothing
    }
  }

  // --- step transitions ---------------------------------------------------

  async completeStep(taskId, index) {
    const task = this.task;
    if (!task || task.taskId !== taskId) return;
    const step = task.steps[index];
    if (!step) return;

    step.status = 'done';
    this.emit({ type: 'step', taskId, index, status: 'done' });

    // Look FORWARD from the step just completed first. A plain findIndex over
    // the whole list also matches 'wrong', so ticking off step 3 while step 1
    // was flagged wrong used to drag the user back to step 1 and point the
    // arrow at a control they were already past.
    const ahead = task.steps.findIndex((s, i) => i > index && s.status !== 'done');
    const next = ahead !== -1 ? ahead : task.steps.findIndex((s) => s.status !== 'done');
    if (next === -1) {
      this.stopWatching();
      this.clearArrow();
      return;
    }

    task.activeIndex = next;
    task.steps[next].status = 'active';
    this.emit({ type: 'step', taskId, index: next, status: 'active' });

    if (this.store.getSettings().pointing) await this._pointAtActiveStep();
  }

  reopenStep(taskId, index) {
    const task = this.task;
    if (!task || task.taskId !== taskId) return;
    const step = task.steps[index];
    if (!step) return;

    step.status = 'active';
    task.activeIndex = index;
    task.failures = 0;
    this.emit({ type: 'step', taskId, index, status: 'active' });

    if (!this.watch && this.store.getSettings().capture !== false) this.startWatching();
    if (this.store.getSettings().pointing) this._pointAtActiveStep();
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Capture without Handrail appearing in its own screenshot.
   *
   * Without this the model reads Handrail's previous answer back to the user,
   * and sees the arrow it drew last time.
   *
   * It used to hide the overlay and show it again, which worked and also made
   * the UI visibly vanish and reappear on every prompt, every arrow and every
   * completion check. Capture exclusion achieves the same thing with nothing
   * moving on screen — see windows.js § excludeFromCapture.
   */
  async _captureWithoutSelf(display, quality) {
    const restore = this.excludeFromCapture();
    // A beat for the change in display affinity to take effect. Far shorter
    // than the frame a hide/show needed, and invisible either way.
    await new Promise((r) => setTimeout(r, 32));

    try {
      return await captureDisplay(display, quality);
    } finally {
      restore();
    }
  }

  /**
   * The thread this turn belongs to.
   *
   * The renderer's open thread wins. Falling back to "most recently updated"
   * was the whole bug: `openThread(id)` is a renderer action that never reached
   * main, so opening an old thread and asking a follow-up read the NEWEST
   * thread's history, appended the turn there, and then emitted `{type:'thread'}`
   * which rewrote the panel header mid-turn to a conversation the user was not
   * looking at. The fallback survives only for the case where nothing is open.
   */
  _currentThread() {
    if (this.threadId) {
      const open = this.store.getThread(this.threadId);
      if (open) return open;
      // Opened then deleted. Fall through rather than throwing away the turn.
      this.threadId = null;
    }
    const threads = this.store.listThreads();
    return threads.length ? this.store.getThread(threads[0].id) : null;
  }

  /**
   * Store what was actually said.
   *
   * This used to save only a one-line summary — for a checklist, just its
   * title. Re-opening a thread then showed a column of repeated headings with
   * no conversation in it, and the model was fed the same thing as history, so
   * it had nothing to be conversational about.
   */
  _record(prompt, reply) {
    let thread = this._currentThread();
    if (!thread) thread = this.store.createThread();
    // Pin it, so the rest of this turn and any follow-up before the renderer
    // speaks again land in the same place.
    this.threadId = thread.id;
    this.store.appendTurn(thread.id, { prompt, ...reply, at: Date.now() });

    // The header names the conversation, and the store is what titles it — from
    // the first prompt. Without this the panel just said "Handrail" forever.
    const titled = this.store.getThread(thread.id);
    if (titled) this.emit({ type: 'thread', id: titled.id, title: titled.title });
  }
}

/**
 * Cheap perceptual fingerprint of a PNG buffer.
 *
 * Sampling the compressed bytes rather than decoding to pixels: decoding every
 * 600ms is real CPU on someone's machine while they are trying to use Premiere,
 * and this only has to answer "did anything meaningfully change", not "what
 * changed". PNG compression means a still screen produces near-identical bytes.
 */
function fingerprint(buffer) {
  const SAMPLES = 512;
  const out = new Uint8Array(SAMPLES);
  const stride = Math.max(1, Math.floor(buffer.length / SAMPLES));
  for (let i = 0; i < SAMPLES; i += 1) out[i] = buffer[i * stride] || 0;
  return out;
}

function difference(a, b) {
  let differing = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > 6) differing += 1;
  }
  return differing / a.length;
}

/**
 * First sentence of an answer, for the arrow's label.
 *
 * The label sits on top of the user's screen next to the arrow; a whole
 * multi-paragraph answer there would cover the thing being pointed at. Markdown
 * markers are stripped because the label is plain text.
 */
const ABBREVIATION = /(^|\s)(e\.g|i\.e|etc|vs|approx|fig|no|Mr|Mrs|Ms|Dr|St|[A-Za-z])\.$/;

function firstSentence(markdown) {
  const plain = String(markdown || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // Every full stop followed by a space is a candidate, but a stop after an
  // abbreviation or an initial is not the end of a sentence. Taking the first
  // one blindly turned "Use the crop tool, e.g. the one in the left toolbar."
  // into the label "Use the crop tool, e.g." — and that label is the only
  // instruction sitting next to the arrow.
  const ends = /[.!?](\s|$)/g;
  let match;
  while ((match = ends.exec(plain)) !== null) {
    const candidate = plain.slice(0, match.index + 1);
    if (candidate.length > 140) break;
    if (ABBREVIATION.test(candidate)) continue;
    return candidate.trim();
  }
  return plain.slice(0, 140).trim();
}

/**
 * Provider and network errors, rewritten for someone who is not technical.
 *
 * These strings are the only diagnosis the user ever sees, so a wrong one sends
 * them to the wrong place. The status codes are matched on word boundaries and
 * `err.status` is preferred: a bare `/5\d\d/` matched "5000 tokens" and told
 * people the provider was down, and `/401/` matched "request 401829" and told
 * them their key was bad.
 */
function friendly(err) {
  const msg = String((err && err.message) || err || '');
  const status = Number((err && (err.status || err.statusCode)) || 0) || null;

  // A code, standing alone rather than embedded in a longer number.
  const has = (code) => new RegExp(`(?<![0-9])${code}(?![0-9])`).test(msg);
  const is = (...codes) => codes.some((c) => status === c || has(c));

  if (err && err.code === 'NO_KEY') return 'No API key set yet. Add one in Settings.';

  /**
   * Screen capture was refused by the OS.
   *
   * `desktopCapturer.getSources()` throws a bare "Failed to get sources." and
   * that string used to go straight to the user, above a "Try again" button
   * that could never work — macOS decides screen-recording access once per
   * process at launch, so a permission granted while Handrail is running does
   * nothing until it restarts. Someone who has just granted the permission and
   * watched it fail anyway has no way to guess that.
   *
   * Observed on 2026-08-09: permission granted mid-session, "Try again"
   * failed identically every time, and a restart fixed it instantly.
   */
  if (/Failed to get sources|No screen sources available|returned an empty image/i.test(msg)) {
    return process.platform === 'darwin'
      ? 'Handrail cannot see your screen. Allow it under Privacy & Security → Screen ' +
        '& System Audio Recording, then restart Handrail — macOS only checks that ' +
        'permission when the app starts.'
      : 'Handrail could not capture your screen. Try again in a moment.';
  }
  if (/Invalid API key/i.test(msg) || is(401, 403)) return 'That API key was rejected. Check it in Settings.';
  if (/Rate limit/i.test(msg) || is(429)) return 'The provider is rate-limiting you. Wait a moment and try again.';
  if (/insufficient|credit|quota/i.test(msg)) return 'Your provider account is out of credit.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) return "Couldn't reach the provider. Check your internet connection.";
  if (/server error/i.test(msg) || (status >= 500 && status <= 599) || /(?<![0-9])5[0-9]{2}(?![0-9])/.test(msg)) {
    return 'The provider is having problems. Try again shortly.';
  }
  return msg || 'Something went wrong.';
}

module.exports = { TurnController, friendly, firstSentence };
