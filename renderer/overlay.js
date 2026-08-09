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
 *
 * The panel is a TRANSCRIPT, not a single answer. Each prompt stays on screen
 * above its reply and the list scrolls. The first build replaced the panel's
 * contents on every turn, which meant you could never see what you had asked,
 * never scroll back, and never compare an answer to the one before it.
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
  quit: $('quit'),
  panel: $('panel'),
  panelTitle: $('panel-title'),
  panelProgress: $('panel-progress'),
  panelClose: $('panel-close'),
  panelClear: $('panel-clear'),
  body: $('panel-body'),
  panelThreads: $('panel-threads'),
  panelSettings: $('panel-settings'),
  threadList: $('thread-list'),
  threadSearch: $('thread-search'),
  threadNew: $('thread-new'),
  settingsBody: $('settings-body'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  view: 'bar',            // 'collapsed' | 'bar' | 'answer'
  turnId: null,           // in-flight turn, or null
  lastPrompt: '',         // for retry
  messages: [],           // the transcript. { id, role, kind, node, ... }
  task: null,             // the live task, if the last reply was one
  pointingAt: null,       // index of the step currently carrying the arrow
  threads: [],
  threadFilter: '',
  openThreadId: null,
  settings: { capture: true, pointing: true, stealth: true, keyHint: '' },
  panel: null,            // 'threads' | 'settings' | null — one at a time
};

let messageSeq = 0;
let turnSeq = 0;

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

/**
 * Follow the conversation only if the user is already at the bottom.
 *
 * Yanking someone back down while they are reading earlier messages is the
 * single most irritating thing a chat transcript can do.
 */
function isNearBottom() {
  const gap = el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight;
  return gap < 48;
}

function followIfAtBottom(wasAtBottom) {
  if (wasAtBottom) el.body.scrollTop = el.body.scrollHeight;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function appendMessage(message) {
  const wasAtBottom = isNearBottom();

  message.id = `m${++messageSeq}`;
  state.messages.push(message);
  el.body.append(message.node);

  followIfAtBottom(wasAtBottom || message.role === 'user');
  scheduleResize();
  return message;
}

function addUserMessage(text) {
  const node = document.createElement('div');
  node.className = 'msg msg--user';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  node.append(bubble);

  return appendMessage({ role: 'user', kind: 'text', node, text });
}

/** The assistant's slot for this turn, created empty and filled as events land. */
function addAssistantMessage() {
  const node = document.createElement('div');
  node.className = 'msg msg--assistant';

  const content = document.createElement('div');
  content.className = 'msg__content';
  node.append(content);

  return appendMessage({ role: 'assistant', kind: null, node, content, text: '' });
}

/** The assistant message currently being written into, if any. */
function currentAssistant() {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if (m.role === 'assistant') return m;
  }
  return null;
}

function clearTranscript() {
  state.messages = [];
  state.task = null;
  state.pointingAt = null;
  el.body.replaceChildren();
  el.panelProgress.hidden = true;
  scheduleResize();
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

async function ask(text) {
  const prompt = String(text || '').trim();
  if (!prompt || state.turnId) return;

  state.lastPrompt = prompt;
  el.input.value = '';

  // Asking is a request to see an answer. Any side panel that happens to be
  // open is in the way of that, so it closes.
  if (state.panel) setPanel(null);

  addUserMessage(prompt);
  addAssistantMessage();

  showBusy('thinking');
  setView('answer');

  // The id is minted HERE and set before the call, not taken from the reply.
  // Main starts emitting the moment it is asked, and a fast answer beats the
  // IPC round trip — so an id that only arrives in the reply means `answer` and
  // `done` land while state.turnId is still null, get dropped as stale, and the
  // bar spins forever with no way to ask anything else.
  const turnId = `t${Date.now().toString(36)}${++turnSeq}`;
  state.turnId = turnId;

  try {
    await bridge.ask({ text: prompt, capture: state.settings.capture, turnId });
  } catch (err) {
    showError((err && err.message) || 'Could not reach Handrail.', true);
  }
}

/** Swap the bar's right-hand cluster. Only one of the three is ever visible. */
function showBusy(mode) {
  el.tools.hidden = mode !== null;
  el.captureFlash.hidden = mode !== 'capture';
  el.thinking.hidden = mode !== 'thinking';
}

function endTurn() {
  state.turnId = null;
  showBusy(null);

  // An assistant slot that never received anything would sit in the transcript
  // as an empty gap.
  const last = currentAssistant();
  if (last && !last.kind) {
    last.node.remove();
    state.messages = state.messages.filter((m) => m !== last);
  }

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

    case 'chunk': {
      const msg = currentAssistant();
      if (!msg) break;
      const wasAtBottom = isNearBottom();
      msg.kind = 'text';
      msg.text += event.text;
      renderProse(msg.content, msg.text);
      followIfAtBottom(wasAtBottom);
      scheduleResize();
      break;
    }

    case 'answer': {
      const msg = currentAssistant();
      if (!msg) break;
      const wasAtBottom = isNearBottom();
      msg.kind = 'text';
      msg.text = event.markdown;
      renderProse(msg.content, msg.text);
      followIfAtBottom(wasAtBottom);
      scheduleResize();
      break;
    }

    case 'task':
      renderTask(event);
      break;

    case 'step':
      updateStep(event);
      break;

    case 'point':
      // The arrow is drawn by main in its own window; the renderer only
      // reflects which step is carrying it.
      state.pointingAt = event.rect && state.task ? state.task.activeIndex : null;
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
function renderProse(target, markdown) {
  target.replaceChildren();
  target.className = 'msg__content prose';

  for (const block of String(markdown || '').split(/\n{2,}/)) {
    const fence = block.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
    if (fence) {
      const pre = document.createElement('pre');
      pre.textContent = fence[1];
      target.append(pre);
      continue;
    }

    const p = document.createElement('p');
    // Split on inline code and bold, keeping the delimiters.
    for (const part of block.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
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
    target.append(p);
  }
}

function renderTask(event) {
  const msg = currentAssistant();
  if (!msg) return;

  msg.kind = 'task';
  msg.content.className = 'msg__content';
  msg.content.replaceChildren();

  const title = document.createElement('p');
  title.className = 'task__title';
  title.textContent = event.title;

  const list = document.createElement('div');
  list.className = 'steps';

  msg.content.append(title, list);

  state.task = {
    taskId: event.taskId,
    title: event.title,
    activeIndex: 0,
    list,
    steps: event.steps.map((s, i) => ({
      text: s.text,
      hint: s.hint || '',
      status: i === 0 ? 'active' : 'todo',
      correction: '',
    })),
  };

  el.panelTitle.textContent = event.title;
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

  const wasAtBottom = isNearBottom();
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
    if (step.status === 'done') mark.append(icon('M5 13l4 4L19 7', 3.4));
    else mark.textContent = String(i + 1);

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
      pointing.append(icon('M5 12h13M12 5l7 7-7 7', 2.6),
        document.createTextNode('Pointing at it on your screen'));
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

  task.list.replaceChildren(frag);
  followIfAtBottom(wasAtBottom);
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
  if (task.steps[index].status === 'done') bridge.reopenStep(task.taskId, index);
  else bridge.completeStep(task.taskId, index);
}

/** Errors are messages in the transcript too — they belong to a prompt. */
function showError(message, recoverable) {
  const msg = currentAssistant() || addAssistantMessage();
  msg.kind = 'error';
  msg.content.className = 'msg__content';
  msg.content.replaceChildren();

  const box = document.createElement('div');
  box.className = 'error';

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9');
  circle.setAttribute('stroke', 'currentColor'); circle.setAttribute('stroke-width', '1.8');
  const bang = document.createElementNS(NS, 'path');
  bang.setAttribute('d', 'M12 7.5v5.5M12 16.2v.6');
  bang.setAttribute('stroke', 'currentColor'); bang.setAttribute('stroke-width', '2');
  bang.setAttribute('stroke-linecap', 'round');
  svg.append(circle, bang);

  const text = document.createElement('p');
  text.className = 'error__text';
  const head = document.createElement('b');
  head.textContent = 'That didn’t work';
  text.append(head, document.createTextNode(message));

  box.append(svg, text);

  if (recoverable) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'error__retry';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => ask(state.lastPrompt));
    box.append(retry);
  }

  msg.content.append(box);
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
  const thread = await bridge.threads.open(id);
  clearTranscript();

  // Replay what was said. Only the prompt and a summary are stored, so an
  // opened thread reads as history rather than as a live conversation — which
  // is honest about what it is.
  for (const turn of (thread && thread.turns) || []) {
    addUserMessage(turn.prompt);
    const msg = addAssistantMessage();
    msg.kind = 'text';
    msg.text = turn.summary || '';
    renderProse(msg.content, msg.text);
  }

  el.panelTitle.textContent = (thread && thread.title) || 'Handrail';
  if (state.messages.length) setView('answer');
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

/**
 * Watching for finished steps is deliberately NOT a setting.
 *
 * It is the thing that makes guidance work for someone who will never click
 * "done" — offering to turn it off invites them to break the product. It is
 * already gated by "Capture my screen", which is the control that genuinely
 * matters: no screenshots means no watching, and that switch is right there.
 */

/**
 * Models offered in Settings. Every one must be vision-capable — Handrail's
 * whole premise is reading the screen, and a text-only model fails in a way
 * that looks like the app being stupid rather than misconfigured.
 *
 * Any OpenRouter id works via OPENROUTER_MODEL; this list is the curated set.
 */
const MODELS = [
  { id: 'google/gemini-2.5-flash',     label: 'Gemini 2.5 Flash — fast, cheapest' },
  { id: 'google/gemini-2.5-pro',       label: 'Gemini 2.5 Pro — better on dense UI' },
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 — strongest reasoning' },
  { id: 'openai/gpt-4o',               label: 'GPT-4o' },
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

  // Model. A dropdown rather than free text: an id with a typo in it fails at
  // request time with a provider error, which reads as Handrail being broken.
  const modelRow = document.createElement('div');
  modelRow.className = 'setting setting--stack';

  const modelLabel = document.createElement('span');
  modelLabel.className = 'setting__label';
  const modelB = document.createElement('b');
  modelB.textContent = 'Model';
  const modelNote = document.createElement('span');
  modelNote.textContent = 'All of these can read your screen';
  modelLabel.append(modelB, modelNote);

  const select = document.createElement('select');
  select.className = 'select';
  select.setAttribute('aria-label', 'Model');

  const known = MODELS.some((m) => m.id === state.settings.model);
  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    if (model.id === state.settings.model) option.selected = true;
    select.append(option);
  }

  // A model set through OPENROUTER_MODEL or an older build would otherwise
  // silently show as whatever happens to be first in the list.
  if (!known && state.settings.model) {
    const option = document.createElement('option');
    option.value = state.settings.model;
    option.textContent = `${state.settings.model} (set outside Handrail)`;
    option.selected = true;
    select.append(option);
  }

  select.addEventListener('change', () => updateSetting('model', select.value));
  modelRow.append(modelLabel, select);
  frag.append(modelRow);

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
  change.addEventListener('click', () => bridge.window.openSetup());

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
  setView('bar');
});

el.panelClear.addEventListener('click', async () => {
  if (state.turnId) bridge.cancel(state.turnId);
  endTurn();
  const { id } = await bridge.threads.create();
  state.openThreadId = id;
  clearTranscript();
  el.panelTitle.textContent = 'Handrail';
  setView('bar');
});

el.quit.addEventListener('click', () => bridge.window.quit());

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
  clearTranscript();
  await refreshThreads();
  setView('bar');
});

// Drag. `-webkit-app-region: drag` handles this natively on both platforms and
// costs nothing; beginDrag() is the fallback for the frameless-window edge
// cases where the region is ignored.
el.grip.addEventListener('mousedown', () => bridge.window.beginDrag());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // Least destructive thing first. Escape should never be the key that loses
  // someone's conversation.
  if (state.panel) return setPanel(null);
  if (state.turnId) {
    bridge.cancel(state.turnId);
    endTurn();
    return;
  }
  if (state.view === 'answer') return setView('bar');
  setView('collapsed');
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
