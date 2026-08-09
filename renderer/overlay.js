/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
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

/**
 * The preload bridge. There is no fallback, deliberately.
 *
 * `mock-bridge.js` fills this in for the standalone dev harness and is excluded
 * from every packaged build — because a shipped mock means a preload that
 * failed to load presents a fully working-looking overlay with invented threads
 * and a canned answer, and nothing on screen says so. Failing loudly here is
 * the whole point.
 */
const bridge = window.handrail;
if (!bridge) {
  document.body.textContent = 'Handrail could not start: the app bridge is missing. Please reinstall.';
  throw new Error('window.handrail is missing — preload did not load');
}

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
  if (state.panel === 'settings' && modelList === null) loadModels();
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
  el.panelTitle.textContent = 'Handrail';
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
    // The open thread goes with the ask. Main cannot know it — `openThread` is
    // a renderer action — so it used to guess "most recently updated", and a
    // follow-up in an old thread was written to the newest one instead.
    await bridge.ask({
      text: prompt,
      capture: state.settings.capture,
      turnId,
      threadId: state.openThreadId,
    });
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

    case 'thread':
      // The header names the conversation, not the latest checklist.
      state.openThreadId = event.id;
      el.panelTitle.textContent = event.title || 'Handrail';
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
 * Markdown: paragraphs, bullet and numbered lists (one level of nesting),
 * fenced code, inline code, bold.
 *
 * Deliberately not a markdown library — the overlay should not ship a parser it
 * cannot audit, and the CSP here forbids remote script anyway. Everything is
 * built with createElement and textContent, so no model output ever reaches
 * innerHTML.
 *
 * Lists matter more than they look. Without them every list the model wrote
 * collapsed into one grey paragraph with stray hyphens in it, which is most of
 * why answers read as thin and generic — the structure was being thrown away
 * on the way to the screen.
 */
const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;

function inline(text) {
  const frag = document.createDocumentFragment();
  // Split on inline code and bold, keeping the delimiters.
  for (const part of String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      frag.append(code);
    } else if (part.startsWith('**') && part.endsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = part.slice(2, -2);
      frag.append(b);
    } else {
      frag.append(document.createTextNode(part));
    }
  }
  return frag;
}

function renderProse(target, markdown) {
  target.replaceChildren();
  target.className = 'msg__content prose';

  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // --- fenced code ---
    if (/^\s*```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;   // closing fence
      const pre = document.createElement('pre');
      pre.textContent = body.join('\n');
      target.append(pre);
      continue;
    }

    // --- list ---
    const match = BULLET.exec(line) || ORDERED.exec(line);
    if (match) {
      const ordered = !BULLET.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      // Indentation of the first item is the baseline; anything deeper nests.
      const baseIndent = match[1].length;
      let sublist = null;

      while (i < lines.length) {
        const item = BULLET.exec(lines[i]) || ORDERED.exec(lines[i]);
        if (!item) {
          // A blank line inside a list is a gap, not the end of it.
          if (!lines[i].trim() && (BULLET.test(lines[i + 1] || '') || ORDERED.test(lines[i + 1] || ''))) {
            i += 1;
            continue;
          }
          break;
        }

        // Kind is decided once, when the list opens, but the loop used to
        // accept both kinds — so `- a\n- b\n1. first` produced ONE <ul> with
        // three items in it and the numbering vanished. A top-level item of the
        // other kind ends this list and starts the next.
        const itemOrdered = !BULLET.test(lines[i]);
        if (item[1].length <= baseIndent + 1 && itemOrdered !== ordered) break;

        const li = document.createElement('li');
        li.append(inline(item[2]));

        if (item[1].length > baseIndent + 1) {
          if (!sublist) {
            sublist = document.createElement(BULLET.test(lines[i]) ? 'ul' : 'ol');
            (list.lastElementChild || list).append(sublist);
          }
          sublist.append(li);
        } else {
          sublist = null;
          list.append(li);
        }
        i += 1;
      }

      target.append(list);
      continue;
    }

    // --- paragraph ---
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !/^\s*```/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    const p = document.createElement('p');
    p.append(inline(para.join(' ')));
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
    // Main auto-advances the checklist by looking at the screen. When it gives
    // up it says so, and the list has to stop pretending otherwise.
    watching: true,
    watchNote: '',
    steps: event.steps.map((s, i) => ({
      text: s.text,
      hint: s.hint || '',
      status: i === 0 ? 'active' : 'todo',
      correction: '',
    })),
  };

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
    // Reopening a step restarts watching in main, so the warning has to go.
    task.watching = true;
    task.watchNote = '';
  } else if (event.status === 'offplan' || event.status === 'unwatched') {
    // Main has stopped watching. Both of these used to fall through to a
    // redraw that looked identical, leaving a checklist that appeared live and
    // would never advance again — with nothing to say the ticks are now the
    // user's job. `offplan` means the screen went somewhere else; `unwatched`
    // means three checks in a row came back unreadable and we stopped paying
    // for a fourth.
    task.watching = false;
    task.watchNote = event.status === 'offplan'
      ? "That's not the screen this checklist is for — tick steps off yourself, or ask again."
      : "Can't tell when these steps finish — tick them off yourself as you go.";
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
    text.append(inline(step.text));
    body.append(text);

    if (step.hint) {
      const hint = document.createElement('span');
      hint.className = 'step__hint';
      hint.append(inline(step.hint));
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

  // Say when the ticks have become the user's job. Without this, a checklist
  // main has stopped watching looks exactly like one it is still watching.
  if (task.watching === false && task.watchNote) {
    const note = document.createElement('p');
    note.className = 'steps__note';
    note.textContent = task.watchNote;
    frag.append(note);
  }

  task.list.replaceChildren(frag);
  followIfAtBottom(wasAtBottom);
  scheduleResize();
}

/**
 * A checklist from an earlier turn, rendered read-only.
 *
 * Not interactive and not tracked: step status is live state belonging to the
 * running task, and offering to tick a step in a conversation that has moved on
 * would be lying about what the click does.
 */
function renderArchivedTask(msg, turn) {
  msg.content.className = 'msg__content';
  msg.content.replaceChildren();

  const title = document.createElement('p');
  title.className = 'task__title';
  title.textContent = turn.title || '';

  const list = document.createElement('div');
  list.className = 'steps steps--archived';

  (turn.steps || []).forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'step';
    row.dataset.status = 'todo';

    const mark = document.createElement('span');
    mark.className = 'step__mark';
    mark.textContent = String(i + 1);

    const body = document.createElement('div');
    const text = document.createElement('p');
    text.className = 'step__text';
    text.append(inline(step.text));
    body.append(text);

    if (step.hint) {
      const hint = document.createElement('span');
      hint.className = 'step__hint';
      hint.append(inline(step.hint));
      text.append(hint);
    }

    row.append(mark, body);
    list.append(row);
  });

  msg.content.append(title, list);
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
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openThreadMenu(e, thread, row);
    });

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

/**
 * Right-click a thread to rename or delete it.
 *
 * A renderer-drawn menu rather than Electron's native one: it inherits the
 * overlay's own styling, and a native menu on a frameless always-on-top window
 * is a second OS surface to keep in step with the first.
 */
let openMenu = null;

function closeThreadMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
}

function openThreadMenu(event, thread, row) {
  closeThreadMenu();

  const menu = document.createElement('div');
  menu.className = 'menu';

  const item = (label, onClick, danger) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (danger) button.className = 'danger';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      closeThreadMenu();
      onClick();
    });
    menu.append(button);
  };

  item('Rename', () => startRename(thread, row));
  item('Delete', () => deleteThread(thread), true);

  document.body.append(menu);

  // Measure, then place, so a menu opened near an edge stays on screen. The
  // overlay window is only as big as its content, so "near an edge" is most
  // of the time.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(window.innerWidth - box.width - 4, event.clientX))}px`;
  menu.style.top = `${Math.max(4, Math.min(window.innerHeight - box.height - 4, event.clientY))}px`;

  openMenu = menu;
}

function startRename(thread, row) {
  const title = row.querySelector('.thread__title');
  if (!title) return;

  const input = document.createElement('input');
  input.className = 'thread__rename';
  input.value = thread.title;
  title.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (save && next && next !== thread.title) await bridge.threads.rename(thread.id, next);
    await refreshThreads();
    // The header shows the open thread's name, so a rename has to reach it.
    if (save && next && thread.id === state.openThreadId) el.panelTitle.textContent = next;
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();              // Escape here means "stop renaming"
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function deleteThread(thread) {
  await bridge.threads.remove(thread.id);
  // Deleting the thread you are reading has to clear it, or the transcript
  // stays on screen belonging to something that no longer exists.
  if (thread.id === state.openThreadId) {
    state.openThreadId = null;
    clearTranscript();
    setView('bar');
  }
  await refreshThreads();
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

  // Replay the actual conversation, both sides. Checklists come back as
  // checklists rather than as their title — a thread that reads as a column of
  // repeated headings is not a record of anything.
  for (const turn of (thread && thread.turns) || []) {
    addUserMessage(turn.prompt);
    const msg = addAssistantMessage();

    if (turn.kind === 'task' && Array.isArray(turn.steps)) {
      msg.kind = 'task';
      renderArchivedTask(msg, turn);
    } else {
      msg.kind = 'text';
      // `summary` is the older record shape; threads written before replies
      // were stored in full still have to open.
      msg.text = turn.markdown || turn.summary || '';
      renderProse(msg.content, msg.text);
    }
  }

  el.panelTitle.textContent = (thread && thread.title) || 'Handrail';
  el.panelProgress.hidden = true;
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
 * Fallback model list, used only when OpenRouter cannot be reached.
 *
 * The real list is fetched live and filtered to models that accept images —
 * hard-coding it limited the choice to whatever ids were known when this was
 * written, and a retired id fails at request time with a provider error that
 * reads as Handrail being broken.
 */
const FALLBACK_MODELS = [
  { id: 'google/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
  { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
];

/**
 * Pinned to the top of a list that runs to a couple of hundred entries.
 *
 * A spread from cheapest-adequate to strongest, not a ranking. Reading a
 * cluttered screen accurately is what separates a useful answer from a
 * confident wrong one, so the choice is worth making deliberately.
 */
const SUGGESTED = [
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5',
];

let modelList = null;

function priceLabel(model) {
  if (!model.inPrice && !model.outPrice) return '';
  const round = (n) => (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(/\.?0+$/, '');
  return `  ·  $${round(model.inPrice)}/$${round(model.outPrice)} per M`;
}

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
  modelNote.textContent = modelList
    ? 'Only models that can read your screen are listed'
    : 'Loading the full list…';
  modelLabel.append(modelB, modelNote);

  const select = document.createElement('select');
  select.className = 'select';
  select.setAttribute('aria-label', 'Model');

  const all = modelList && modelList.length ? modelList : FALLBACK_MODELS;

  // A handful of sensible defaults first, then everything else. The full list
  // runs to dozens of models and alphabetical order alone buries the ones most
  // people should actually pick.
  const suggested = SUGGESTED.map((id) => all.find((m) => m.id === id)).filter(Boolean);
  const rest = all.filter((m) => !SUGGESTED.includes(m.id));

  const addOptions = (group, models) => {
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name + priceLabel(model);
      if (model.id === state.settings.model) option.selected = true;
      group.append(option);
    }
  };

  if (suggested.length) {
    const group = document.createElement('optgroup');
    group.label = 'Suggested';
    addOptions(group, suggested);
    select.append(group);
  }

  const group = document.createElement('optgroup');
  group.label = suggested.length ? `All vision models (${rest.length})` : 'Models';
  addOptions(group, rest);
  select.append(group);

  // A model set through OPENROUTER_MODEL, or one that has since been retired,
  // would otherwise silently display as whichever entry sorts first.
  if (state.settings.model && !all.some((m) => m.id === state.settings.model)) {
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

/**
 * Fetch the model list once, lazily.
 *
 * On opening Settings rather than at boot: it is a network call the user has
 * not asked for until they look at the dropdown, and the fallback list means
 * the control works immediately either way.
 */
async function loadModels() {
  try {
    modelList = await bridge.models();
  } catch (_) {
    modelList = [];
  }
  if (state.panel === 'settings') renderSettings();
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

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeThreadMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // The menu is the most recent thing opened, so it is the first thing closed.
  if (openMenu) { closeThreadMenu(); return; }

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
