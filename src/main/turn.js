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
const { parseBox, isBoxSane, boxToScreenRect } = require('../../spike/arrow/geometry');

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
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.turnId = 0;
    this.active = null;   // { id, cancelled }
    this.task = null;     // { taskId, steps, activeIndex, display }
    this.watch = null;    // watching loop handle
  }

  // --- lifecycle ----------------------------------------------------------

  async ask({ text, capture }) {
    this.cancel();                       // one turn at a time, always
    const id = `turn_${++this.turnId}`;
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

  cancel() {
    if (this.active) this.active.cancelled = true;
    this.active = null;
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
      // Hide the overlay so Handrail's own UI is not in the screenshot it
      // reasons about. Without this the model reads its own last answer back.
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
    });
    if (turn.cancelled) return;

    if (result.kind === 'task') {
      await this._startTask(turn, result, display, text);
    } else {
      this.emit({ type: 'answer', turnId: turn.id, markdown: result.markdown });
      this.emit({ type: 'done', turnId: turn.id });
      this._record(text, result.markdown);
      this.active = null;
    }
  }

  async _startTask(turn, plan, display, prompt) {
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
    this._record(prompt, plan.title);
    this.active = null;

    const settings = this.store.getSettings();
    if (settings.pointing && display) await this._pointAtActiveStep();
    if (settings.watching && display) this.startWatching();
  }

  // --- arrow --------------------------------------------------------------

  async _pointAtActiveStep() {
    const task = this.task;
    if (!task || !task.display) return;

    const step = task.steps[task.activeIndex];
    if (!step || !step.target) return this.point(null);

    try {
      const { buffer, size } = await this._captureWithoutSelf(task.display, 'full');
      if (!captureMatchesDisplay(size, task.display)) return this.point(null);

      const found = await this.llm.locate({ screenshot: buffer, target: step.target });
      if (!found || found.found === false) return this.point(null);

      const box = parseBox(found);
      // The sanity check is the guard against a model that ignored the 0-1000
      // convention and returned raw pixels — which would map the arrow several
      // screens to the right rather than erroring.
      if (!isBoxSane(box)) return this.point(null);

      const rect = boxToScreenRect(box, task.display);
      this.point({
        display: task.display,
        local: rect.local,
        label: found.label || step.target,
        instruction: step.text,
      });
      this.emit({ type: 'point', rect: rect.screen });
    } catch (err) {
      // Pointing is an enhancement. If it fails the steps still work, so it
      // fails silently rather than turning a working answer into an error.
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
        const { buffer } = await captureDisplay(task.display, 'check');
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

    if (!this.watch && this.store.getSettings().watching) this.startWatching();
    if (this.store.getSettings().pointing) this._pointAtActiveStep();
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Capture with Handrail's own windows hidden.
   *
   * Without this the overlay appears in every screenshot and the model starts
   * describing Handrail's previous answer back to the user. The arrow window
   * is hidden too, or the model sees the arrow it drew last time.
   */
  async _captureWithoutSelf(display, quality) {
    const overlay = this.getOverlay();
    const wasVisible = overlay && !overlay.isDestroyed() && overlay.isVisible();

    if (wasVisible) overlay.hide();
    this.point(null);
    // One frame for the compositor to actually drop them. Without the wait the
    // capture still contains the window that was just hidden.
    await new Promise((r) => setTimeout(r, 90));

    try {
      return await captureDisplay(display, quality);
    } finally {
      if (wasVisible && overlay && !overlay.isDestroyed()) overlay.showInactive();
    }
  }

  _currentThread() {
    const threads = this.store.listThreads();
    return threads.length ? this.store.getThread(threads[0].id) : null;
  }

  _record(prompt, summary) {
    let thread = this._currentThread();
    if (!thread) thread = this.store.createThread();
    this.store.appendTurn(thread.id, { prompt, summary, at: Date.now() });
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
