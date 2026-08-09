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
  async ask({ text, capture, turnId }) {
    // Abort any in-flight request, but LEAVE THE TASK ALONE. This used to call
    // cancel(), which also stopped the watching loop and cleared the arrow — so
    // asking "now what?" in the middle of a task quietly abandoned it.
    this._abortRequest();
    const id = turnId || `turn_${++this.turnId}`;
    const turn = { id, cancelled: false };
    this.active = turn;

    // Fire and forget: the renderer already has the turnId and everything
    // else arrives as events. Awaiting here would block the IPC reply on the
    // whole model round-trip.
    this._run(turn, { text, capture }).catch((err) => {
      if (turn.cancelled) return;
      this.emit({ type: 'error', turnId: id, message: friendly(err), recoverable: true });
      this.emit({ type: 'done', turnId: id });
    });

    return { turnId: id };
  }

  /** Abort the in-flight model request. The task, if any, survives. */
  _abortRequest() {
    if (this.active) this.active.cancelled = true;
    this.active = null;
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
    this.stopWatching();
    this.point(null);
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
    const taskId = `task_${turn.id}`;
    this.task = {
      taskId,
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
    if (display) this.startWatching();
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
    if (!step || !step.target) return this.point(null);

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
    if (!display || !target) return this.point(null);

    try {
      let buffer = screenshot;
      if (!buffer) {
        const shot = await this._captureWithoutSelf(display, 'full');
        if (!captureMatchesDisplay(shot.size, display)) return this.point(null);
        buffer = shot.buffer;
      }

      const found = await this.llm.locate({ screenshot: buffer, target });
      if (!found || found.found === false) return this.point(null);

      const box = parseBox(found);
      // The sanity check is the guard against a model that ignored the 0-1000
      // convention and returned raw pixels — which would map the arrow several
      // screens to the right rather than erroring.
      if (!isBoxSane(box)) return this.point(null);

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
      this.point(null);
    }
  }

  // --- watching -----------------------------------------------------------

  startWatching() {
    this.stopWatching();
    const task = this.task;
    if (!task || !task.display) return;

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
        const { buffer } = await this._captureWithoutSelf(task.display, 'check');
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
        this.point(null);
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

    // Advance to the first unfinished step rather than index+1: a user can
    // tick steps off in any order, and auto-advance runs alongside them.
    const next = task.steps.findIndex((s) => s.status !== 'done');
    if (next === -1) {
      this.stopWatching();
      this.point(null);
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

    if (!this.watch) this.startWatching();
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

  _currentThread() {
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
function firstSentence(markdown) {
  const plain = String(markdown || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const match = plain.match(/^(.{0,140}?[.!?])(\s|$)/);
  return (match ? match[1] : plain.slice(0, 140)).trim();
}

/** Provider and network errors, rewritten for someone who is not technical. */
function friendly(err) {
  const msg = String((err && err.message) || err || '');
  if (err && err.code === 'NO_KEY') return 'No API key set yet. Add one in Settings.';
  if (/Invalid API key|401|403/i.test(msg)) return 'That API key was rejected. Check it in Settings.';
  if (/Rate limit|429/i.test(msg)) return 'The provider is rate-limiting you. Wait a moment and try again.';
  if (/insufficient|credit|quota/i.test(msg)) return 'Your provider account is out of credit.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) return "Couldn't reach the provider. Check your internet connection.";
  if (/server error|5\d\d/i.test(msg)) return 'The provider is having problems. Try again shortly.';
  return msg || 'Something went wrong.';
}

module.exports = { TurnController, friendly };
