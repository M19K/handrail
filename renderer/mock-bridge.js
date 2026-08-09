/**
 * Handrail — mock IPC bridge. DEVELOPMENT ONLY.
 *
 * Installs a fake `window.handrail` when the real preload bridge is absent, so
 * the overlay can be opened in an ordinary browser and driven through every
 * state without Electron, a main process, or an API key.
 *
 * Why this exists: the renderer is the part of Handrail whose correctness is
 * judged by eye, and eyeballing it should not require a running app and a
 * funded provider. It also means the renderer can be built and reviewed before
 * the main process is rewired, rather than the two landing together untested.
 *
 * It no-ops entirely under Electron — the real bridge wins.
 *
 * Scenarios, typed into the bar:
 *   anything containing "how do I" / "set up" / "add"  -> multi-step task
 *   "fail"                                             -> recoverable error
 *   anything else                                      -> quick answer
 */

(function installMockBridge() {
  if (window.handrail) return;                 // real preload present
  console.info('[handrail] mock bridge active — no main process');

  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => fn(event));

  let seq = 0;
  let cancelled = new Set();
  const timers = [];
  const after = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearAll = () => { while (timers.length) clearTimeout(timers.pop()); };

  const settings = {
    capture: true,
    pointing: true,
    stealth: true,
    model: 'google/gemini-2.5-flash',
    keyHint: 'OpenRouter · sk-or-v1-••••2f9c',
  };

  const now = Date.now();
  const threads = [
    { id: 't1', title: 'Cross dissolve in Premiere',        updatedAt: now - 60e3 },
    { id: 't2', title: 'Why is my export so large',         updatedAt: now - 2 * 3600e3 },
    { id: 't3', title: 'Setting up Unreal for the first time', updatedAt: now - 3 * 86400e3 },
    { id: 't4', title: 'Excel pivot table by month',        updatedAt: now - 5 * 86400e3 },
  ];

  const TASK = {
    title: 'Add a cross dissolve between two clips',
    steps: [
      { text: 'Open the Effects panel from the Window menu.' },
      { text: 'Select the Razor tool in the toolbar on the left.' },
      { text: 'Cut both clips at the point they should overlap.' },
      { text: 'Drag Cross Dissolve onto the join between them.',
        hint: "It's under Video Transitions → Dissolve." },
      { text: 'Drag either edge of the transition to change its length.' },
    ],
  };

  const ANSWER =
    "The red bar under your timeline means Premiere hasn't rendered a preview for " +
    "that section yet, so playback there will stutter. It isn't an error.\n\n" +
    "Press **Enter** with the timeline focused and Premiere will render it. The bar " +
    "turns green when it's done.";

  function runTask(turnId) {
    const taskId = 'task-' + turnId;
    after(700, () => {
      if (cancelled.has(turnId)) return;
      emit({ type: 'task', turnId, taskId, title: TASK.title, steps: TASK.steps });
      emit({ type: 'point', rect: { x: 120, y: 300, w: 24, h: 24 } });
      emit({ type: 'done', turnId });
    });

    // Auto-advance, to demonstrate the behaviour the product actually depends
    // on: the user never ticks anything and the checklist moves anyway.
    let i = 0;
    const advance = () => {
      if (cancelled.has(turnId) || i >= TASK.steps.length) return;
      emit({ type: 'step', taskId, index: i, status: 'done' });
      i += 1;
      after(2600, advance);
    };
    after(3600, advance);
  }

  function runAnswer(turnId) {
    // Streamed a few words at a time, so the renderer's chunk path is exercised
    // rather than just its final-answer path.
    const words = ANSWER.split(' ');
    let at = 0;
    const push = () => {
      if (cancelled.has(turnId)) return;
      if (at >= words.length) {
        emit({ type: 'answer', turnId, markdown: ANSWER });
        emit({ type: 'done', turnId });
        return;
      }
      emit({ type: 'chunk', turnId, text: words.slice(at, at + 3).join(' ') + ' ' });
      at += 3;
      after(55, push);
    };
    after(650, push);
  }

  window.handrail = {
    ask({ text, capture }) {
      clearAll();
      const turnId = 'turn-' + (++seq);
      const prompt = String(text || '').toLowerCase();

      if (capture) after(120, () => emit({ type: 'capture', turnId }));

      // Deliberately late: for a fast task this fires AFTER `done`. Real main
      // can race the same way, and an ordering bug here used to swap the bar's
      // controls for a spinner that never stopped. Left in as a live check that
      // the renderer drops events for a turn that has already ended.
      after(capture ? 1500 : 120, () => emit({ type: 'thinking', turnId }));

      if (prompt.includes('fail')) {
        after(900, () => emit({
          type: 'error', turnId, recoverable: true,
          message: ' Handrail couldn’t reach the provider. Check your connection and try again.',
        }));
      } else if (/how do i|set up|setup|add |install|configure/.test(prompt)) {
        runTask(turnId);
      } else {
        runAnswer(turnId);
      }

      return Promise.resolve({ turnId });
    },

    cancel(turnId) {
      cancelled.add(turnId);
      clearAll();
      return Promise.resolve();
    },

    completeStep(taskId, index) {
      emit({ type: 'step', taskId, index, status: 'done' });
      return Promise.resolve();
    },
    reopenStep(taskId, index) {
      emit({ type: 'step', taskId, index, status: 'active' });
      return Promise.resolve();
    },

    onTurn(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    threads: {
      list: () => Promise.resolve(threads.slice().sort((a, b) => b.updatedAt - a.updatedAt)),
      open: (id) => Promise.resolve({ id, title: '', turns: [] }),
      create: () => {
        const id = 't' + (threads.length + 1) + '-' + Date.now();
        threads.push({ id, title: 'New thread', updatedAt: Date.now() });
        return Promise.resolve({ id });
      },
      rename: (id, title) => {
        const t = threads.find((x) => x.id === id);
        if (t) t.title = title;
        return Promise.resolve();
      },
      remove: (id) => {
        const i = threads.findIndex((x) => x.id === id);
        if (i > -1) threads.splice(i, 1);
        return Promise.resolve();
      },
    },

    models: () => Promise.resolve([
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', inPrice: 0.3, outPrice: 2.5 },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', inPrice: 1.25, outPrice: 10 },
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', inPrice: 3, outPrice: 15 },
      { id: 'openai/gpt-4o', name: 'GPT-4o', inPrice: 2.5, outPrice: 10 },
    ]),

    settings: {
      get: () => Promise.resolve({ ...settings }),
      set: (patch) => Promise.resolve(Object.assign(settings, patch)),
    },

    // Window control is meaningless in a browser tab, but the calls must still
    // resolve or the renderer's await chains stall.
    window: {
      setState: (s) => { document.title = 'Handrail — ' + s; return Promise.resolve(); },
      resize: ({ w, h }) => {
        const badge = document.getElementById('mock-size');
        if (badge) badge.textContent = `${w} × ${h}`;
        return Promise.resolve();
      },
      beginDrag: () => Promise.resolve(),
      close: () => Promise.resolve(),
      quit: () => Promise.resolve(),
    },

    setup: {
      validateKey: (key) => Promise.resolve({
        valid: /^sk-or-v1-[a-f0-9]{8,}$/i.test(key), provider: 'OpenRouter',
      }),
      saveKey: () => Promise.resolve(),
      requestScreenAccess: () => Promise.resolve({ granted: true }),
      complete: () => Promise.resolve(),
      openExternal: () => Promise.resolve(),
    },
  };

  // A readout of the size the renderer is asking main for. The window-resize
  // path has no visible effect in a browser, and a silent no-op is exactly the
  // kind of thing that stays broken until it ships.
  document.addEventListener('DOMContentLoaded', () => {
    const badge = document.createElement('div');
    badge.id = 'mock-size';
    badge.style.cssText =
      'position:fixed;right:10px;bottom:10px;z-index:99;font:10px ui-monospace,monospace;' +
      'color:rgba(255,255,255,.34);background:rgba(0,0,0,.5);padding:4px 7px;border-radius:4px;' +
      'pointer-events:none';
    document.body.append(badge);
  });
})();
