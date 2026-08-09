/**
 * Handrail — overlay renderer.
 *
 * One window, three states, two side panels. Replaces four separate renderer
 * windows that each carried their own lifecycle, styling and IPC listeners.
 *
 * The renderer owns no truth. Threads, steps, settings and keys live in the
 * main process; this file renders what it is told and reports what the user
 * did. Every event arrives on one stream (`handrail.onTurn`) and is handled by
 * one switch — see docs/IPC.md.
 */

'use strict';

const bridge = window.handrail;

// ---------------------------------------------------------------------------
// Element handles
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  pill: $('pill'),
  pillGrip: $('pill-grip'),
  dock: $('dock'),
  bar: $('bar'),
  grip: $('grip'),
  input: $('input'),
  tools: $('tools'),
  captureFlash: $('capture-flash'),
  thinking: $('thinking'),
  toggleCapture: $('toggle-capture'),
  toggleThreads: $('toggle-threads'),
  toggleSettings: $('toggle-settings'),
  panel: $('panel'),
  panelKind: $('panel-kind'),
  panelTitle: $('panel-title'),
  panelProgress: $('panel-progress'),
  panelClose: $('panel-close'),
  prose: $('answer-prose'),
  steps: $('answer-steps'),
  errorBox: $('answer-error'),
  errorText: $('error-text'),
  errorRetry: $('error-retry'),
  panelThreads: $('panel-threads'),
  panelSettings: $('panel-settings'),
  threadList: $('thread-list'),
  threadSearch: $('thread-search'),
  threadNew: $('thread-new'),
  settingsBody: $('settings-body'),
};

// ---------------------------------------------------------------------------
// State
//
// Small and explicit. Everything the renderer needs to decide what to paint,
// and nothing that main is authoritative about.
// ---------------------------------------------------------------------------

const state = {
  view: 'bar',            // 'collapsed' | 'bar' | 'answer'
  turnId: null,           // in-flight turn, or null
  lastPrompt: '',         // for retry
  kind: null,             // 'answer' | 'task' | 'error'
  task: null,             // { taskId, title, steps: [{ text, hint, status }] }
  pointingAt: null,       // index of the step currently carrying the arrow
  threads: [],
  threadFilter: '',
  openThreadId: null,
  settings: { capture: true, pointing: true, stealth: true, keyHint: '' },
  panel: null,            // 'threads' | 'settings' | null — one at a time
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function setView(view) {
  state.view = view;

  el.pill.hidden = view !== 'collapsed';
  el.dock.hidden = view === 'collapsed';
  el.bar.hidden = view === 'collapsed';
  el.panel.hidden = view !== 'answer';

  // Panels belong to the expanded states only; leaving one open behind a
  // collapsed pill would resize the window around something invisible.
  if (view === 'collapsed') setPanel(null);

  bridge.window.setState(view);
  if (view === 'bar' || view === 'answer') el.input.focus();
  scheduleResize();
}

function setPanel(which) {
  state.panel = state.panel === which ? null : which;

  el.panelThreads.hidden = state.panel !== 'threads';
  el.panelSettings.hidden = state.panel !== 'settings';
  el.toggleThreads.setAttribute('aria-pressed', String(state.panel === 'threads'));
  el.toggleSettings.setAttribute('aria-pressed', String(state.panel === 'settings'));

  if (state.panel === 'threads') refreshThreads();
  scheduleResize();
}

/**
 * The window resizes to its content rather than being one large transparent
 * pane with click-through hit-testing. Hit-testing means tracking the cursor to
 * decide what is clickable, which is fragile on both platforms and costs a lot
 * to get right; measuring is not.
 *
 * Two frames of delay: one for layout, one for the animation that may have
 * changed the height. Measuring inside the same frame reports the pre-layout
 * size and the window ends up a step behind the UI.
 */
let resizeHandle = null;
function scheduleResize() {
  if (resizeHandle) cancelAnimationFrame(resizeHandle);
  resizeHandle = requestAnimationFrame(() => {
    resizeHandle = requestAnimationFrame(() => {
      resizeHandle = null;
      const r = el.app.getBoundingClientRect();
      bridge.window.resize({
        w: Math.ceil(r.width + 28),   // #app's horizontal padding
        h: Math.ceil(r.height + 26),  // #app's vertical padding
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

async function ask(text) {
  const prompt = text.trim();
  if (!prompt || state.turnId) return;

  state.lastPrompt = prompt;
  el.input.value = '';
  el.input.blur();

  showBusy('thinking');
  resetPanelContent();

  el.panelKind.textContent = 'Working';
  el.panelTitle.textContent = prompt;
  el.panelProgress.hidden = true;
  setView('answer');

  try {
    const { turnId } = await bridge.ask({ text: prompt, capture: state.settings.capture });
    state.turnId = turnId;
  } catch (err) {
    showError(err && err.message ? err.message : 'Could not reach Handrail.', true);
  }
}

/** Swap the bar's right-hand cluster. Only one of the three is ever visible. */
function showBusy(mode) {
  el.tools.hidden = mode !== null;
  el.captureFlash.hidden = mode !== 'capture';
  el.thinking.hidden = mode !== 'thinking';
  if (mode === null) el.tools.hidden = false;
}

function resetPanelContent() {
  el.prose.hidden = true;
  el.prose.textContent = '';
  el.steps.hidden = true;
  el.steps.replaceChildren();
  el.errorBox.hidden = true;
  state.task = null;
  state.pointingAt = null;
}

function endTurn() {
  state.turnId = null;
  showBusy(null);
  scheduleResize();
}

// ---------------------------------------------------------------------------
// The single event stream
// ---------------------------------------------------------------------------

bridge.onTurn((event) => {
  // Drop anything belonging to a turn that is no longer the current one —
  // including when there is no current turn, i.e. it already finished or was
  // cancelled. A late chunk from an abandoned turn appending itself to a fresh
  // answer is the classic streaming bug, and a stale `thinking` arriving after
  // `done` silently swaps the bar's controls out for a spinner that never stops.
  //
  // `step` and `point` deliberately carry no turnId: step-watching continues
  // long after the turn that produced the plan has ended.
  if (event.turnId && event.turnId !== state.turnId) return;

  switch (event.type) {
    case 'capture':
      showBusy('capture');
      // The flash reports an event; it should not become furniture.
      setTimeout(() => { if (state.turnId) showBusy('thinking'); }, 1500);
      break;

    case 'thinking':
      showBusy('thinking');
      break;

    case 'chunk':
      state.kind = 'answer';
      el.panelKind.textContent = 'Answer';
      el.prose.hidden = false;
      el.prose.textContent += event.text;
      scheduleResize();
      break;

    case 'answer':
      state.kind = 'answer';
      el.panelKind.textContent = 'Answer';
      el.prose.hidden = false;
      renderProse(event.markdown);
      scheduleResize();
      break;

    case 'task':
      renderTask(event);
      break;

    case 'step':
      updateStep(event);
      break;

    case 'point':
      // The arrow is drawn by main in its own window; the renderer only
      // reflects which step is carrying it.
      state.pointingAt = event.rect ? state.task && state.task.activeIndex : null;
      if (state.task) renderSteps();
      break;

    case 'error':
      showError(event.message, event.recoverable);
      break;

    case 'done':
      endTurn();
      break;
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Minimal markdown: paragraphs, inline code, fenced code, bold.
 *
 * Deliberately not a markdown library. Answers are short instructions, the
 * overlay must not ship a parser it cannot audit, and the CSP here forbids
 * remote script anyway. Everything is built with createElement and textContent
 * so no model output can ever reach innerHTML.
 */
function renderProse(markdown) {
  el.prose.replaceChildren();
  const blocks = String(markdown || '').split(/\n{2,}/);

  for (const block of blocks) {
    const fence = block.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
    if (fence) {
      const pre = document.createElement('pre');
      pre.textContent = fence[1];
      el.prose.append(pre);
      continue;
    }

    const p = document.createElement('p');
    // Split on inline code and bold, keeping the delimiters.
    const parts = block.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`')) {
        const code = document.createElement('code');
        code.textContent = part.slice(1, -1);
        p.append(code);
      } else if (part.startsWith('**') && part.endsWith('**')) {
        const b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        p.append(b);
      } else {
        p.append(document.createTextNode(part));
      }
    }
    el.prose.append(p);
  }
}

function renderTask(event) {
  state.kind = 'task';
  state.task = {
    taskId: event.taskId,
    title: event.title,
    activeIndex: 0,
    steps: event.steps.map((s, i) => ({
      text: s.text,
      hint: s.hint || '',
      status: i === 0 ? 'active' : 'todo',
      correction: '',
    })),
  };

  el.panelKind.hidden = true;
  el.panelTitle.textContent = event.title;
  el.prose.hidden = true;
  el.steps.hidden = false;
  renderSteps();
}

function updateStep(event) {
  const task = state.task;
  if (!task || task.taskId !== event.taskId) return;

  const step = task.steps[event.index];
  if (!step) return;

  if (event.status === 'wrong') {
    step.status = 'wrong';
    step.correction = event.correction || '';
  } else if (event.status === 'done') {
    step.status = 'done';
    step.correction = '';
    // Advance to the first step that is not finished. Explicit rather than
    // index+1, because a user can complete steps out of order.
    const next = task.steps.findIndex((s) => s.status !== 'done');
    task.activeIndex = next === -1 ? task.steps.length : next;
    if (next !== -1) task.steps[next].status = 'active';
  } else if (event.status === 'active') {
    step.status = 'active';
    step.correction = '';
    task.activeIndex = event.index;
  }

  renderSteps();
}

function renderSteps() {
  const task = state.task;
  if (!task) return;

  const done = task.steps.filter((s) => s.status === 'done').length;
  el.panelProgress.hidden = false;
  el.panelProgress.textContent = `${Math.min(done + 1, task.steps.length)} / ${task.steps.length}`;

  const frag = document.createDocumentFragment();

  task.steps.forEach((step, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'step';
    row.dataset.status = step.status;
    // The manual escape hatch. Present on every step, required on none.
    row.setAttribute('aria-label',
      step.status === 'done' ? `Reopen step ${i + 1}` : `Mark step ${i + 1} done`);
    row.addEventListener('click', () => toggleStep(i));

    const mark = document.createElement('span');
    mark.className = 'step__mark';
    if (step.status === 'done') {
      mark.append(icon('M5 13l4 4L19 7', 3.4));
    } else {
      mark.textContent = String(i + 1);
    }

    const body = document.createElement('div');

    const text = document.createElement('p');
    text.className = 'step__text';
    text.textContent = step.text;
    body.append(text);

    if (step.hint) {
      const hint = document.createElement('span');
      hint.className = 'step__hint';
      hint.textContent = step.hint;
      text.append(hint);
    }

    if (step.status === 'active' && state.settings.pointing && state.pointingAt === i) {
      const pointing = document.createElement('span');
      pointing.className = 'step__pointing';
      pointing.append(icon('M5 12h13M12 5l7 7-7 7', 2.6), document.createTextNode('Pointing at it on your screen'));
      body.append(pointing);
    }

    if (step.status === 'wrong' && step.correction) {
      const corr = document.createElement('p');
      corr.className = 'step__correction';
      corr.textContent = step.correction;
      body.append(corr);
    }

    row.append(mark, body);
    frag.append(row);
  });

  el.steps.replaceChildren(frag);
  scheduleResize();
}

function icon(d, width) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', String(width));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function toggleStep(index) {
  const task = state.task;
  if (!task) return;
  const step = task.steps[index];
  if (step.status === 'done') bridge.reopenStep(task.taskId, index);
  else bridge.completeStep(task.taskId, index);
}

function showError(message, recoverable) {
  state.kind = 'error';
  resetPanelContent();
  el.panelKind.hidden = false;
  el.panelKind.textContent = 'Problem';
  el.errorBox.hidden = false;
  el.errorText.replaceChildren();

  const head = document.createElement('b');
  head.textContent = 'That didn’t work';
  el.errorText.append(head, document.createTextNode(message));

  el.errorRetry.hidden = !recoverable;
  setView('answer');
  endTurn();
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

async function refreshThreads() {
  state.threads = await bridge.threads.list();
  renderThreads();
}

function renderThreads() {
  const filter = state.threadFilter.toLowerCase();
  const shown = filter
    ? state.threads.filter((t) => t.title.toLowerCase().includes(filter))
    : state.threads;

  const frag = document.createDocumentFragment();

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'side__group';
    empty.textContent = filter ? 'Nothing matches' : 'No threads yet';
    frag.append(empty);
  }

  // Grouped by recency. Absolute dates would be noise for a list this short.
  let lastGroup = null;
  for (const thread of shown) {
    const group = relativeGroup(thread.updatedAt);
    if (group !== lastGroup) {
      const header = document.createElement('div');
      header.className = 'side__group';
      header.textContent = group;
      frag.append(header);
      lastGroup = group;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'thread';
    if (thread.id === state.openThreadId) row.setAttribute('aria-current', 'true');
    row.addEventListener('click', () => openThread(thread.id));

    const title = document.createElement('span');
    title.className = 'thread__title';
    title.textContent = thread.title;

    const time = document.createElement('time');
    time.className = 'thread__time';
    time.textContent = relativeTime(thread.updatedAt);

    row.append(title, time);
    frag.append(row);
  }

  el.threadList.replaceChildren(frag);
  scheduleResize();
}

function relativeGroup(ts) {
  const days = (Date.now() - ts) / 86400000;
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Earlier';
}

function relativeTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function openThread(id) {
  state.openThreadId = id;
  await bridge.threads.open(id);
  renderThreads();
}

// ---------------------------------------------------------------------------
// Settings
//
// Rows are declared here rather than in the HTML because each one is a
// setting name, a plain-English description and a key on the settings object —
// keeping those three together is what stops them drifting apart.
// ---------------------------------------------------------------------------

const SETTING_ROWS = [
  { key: 'capture',  label: 'Capture my screen',        note: 'Every question includes a screenshot' },
  { key: 'pointing', label: 'Point at things on screen', note: 'Draw an arrow at the control to use' },
  { key: 'stealth',  label: 'Hide from screen sharing',  note: "Handrail won't appear in calls or recordings" },
];

async function refreshSettings() {
  state.settings = await bridge.settings.get();
  el.toggleCapture.setAttribute('aria-pressed', String(state.settings.capture));
  renderSettings();
}

function renderSettings() {
  const frag = document.createDocumentFragment();

  for (const row of SETTING_ROWS) {
    const wrap = document.createElement('div');
    wrap.className = 'setting';

    const label = document.createElement('span');
    label.className = 'setting__label';
    const b = document.createElement('b');
    b.textContent = row.label;
    const note = document.createElement('span');
    note.textContent = row.note;
    label.append(b, note);

    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!state.settings[row.key]));
    sw.setAttribute('aria-label', row.label);
    sw.addEventListener('click', () => updateSetting(row.key, !state.settings[row.key]));

    wrap.append(label, sw);
    frag.append(wrap);
  }

  // The key row is not a toggle — it shows a masked hint and hands back to
  // setup. The key itself never crosses the bridge after onboarding.
  const keyRow = document.createElement('div');
  keyRow.className = 'setting';
  const keyLabel = document.createElement('span');
  keyLabel.className = 'setting__label';
  const keyB = document.createElement('b');
  keyB.textContent = 'API key';
  const keyNote = document.createElement('span');
  keyNote.textContent = state.settings.keyHint || 'Not set';
  keyLabel.append(keyB, keyNote);

  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'chip chip--quiet';
  change.textContent = 'Change';

  keyRow.append(keyLabel, change);
  frag.append(keyRow);

  el.settingsBody.replaceChildren(frag);
  scheduleResize();
}

async function updateSetting(key, value) {
  state.settings = await bridge.settings.set({ [key]: value });
  if (key === 'capture') el.toggleCapture.setAttribute('aria-pressed', String(state.settings.capture));
  renderSettings();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.bar.addEventListener('submit', (e) => {
  e.preventDefault();
  ask(el.input.value);
});

el.pill.addEventListener('click', () => setView('bar'));

el.panelClose.addEventListener('click', () => {
  if (state.turnId) bridge.cancel(state.turnId);
  endTurn();
  resetPanelContent();
  el.panelKind.hidden = false;
  setView('bar');
});

el.toggleCapture.addEventListener('click', () => updateSetting('capture', !state.settings.capture));
el.toggleThreads.addEventListener('click', () => setPanel('threads'));
el.toggleSettings.addEventListener('click', () => setPanel('settings'));

el.threadSearch.addEventListener('input', () => {
  state.threadFilter = el.threadSearch.value;
  renderThreads();
});
el.threadNew.addEventListener('click', async () => {
  const { id } = await bridge.threads.create();
  state.openThreadId = id;
  await refreshThreads();
  setView('bar');
});

el.errorRetry.addEventListener('click', () => ask(state.lastPrompt));

// Drag. `-webkit-app-region: drag` handles this natively on both platforms and
// costs nothing; beginDrag() is the fallback for the frameless-window edge
// cases where the region is ignored.
el.grip.addEventListener('mousedown', () => bridge.window.beginDrag());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.panel) return setPanel(null);
    if (state.turnId) {
      bridge.cancel(state.turnId);
      endTurn();
      return;
    }
    if (state.view === 'answer') {
      resetPanelContent();
      el.panelKind.hidden = false;
      return setView('bar');
    }
    setView('collapsed');
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function start() {
  await refreshSettings();
  // Expanded bar on launch — the product should be ready to be typed into,
  // not waiting to be opened.
  setView('bar');
})();
