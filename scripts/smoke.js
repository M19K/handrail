/**
 * Handrail — smoke test.
 *
 * Boots the real main-process modules — the real store, the real IPC handlers,
 * the real preload — opens each window and writes a PNG of it, then quits.
 *
 * The renderer harness (renderer/dev.js) proves the UI against a mock bridge.
 * This proves the other half: that the windows actually come up, that preload
 * exposes what the renderer expects, and that the IPC handlers answer. Those
 * are the failures a mock cannot catch, and they are silent — a window that
 * fails to boot looks identical to a window that is merely empty.
 *
 *   npx electron scripts/smoke.js
 */

const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Store } = require('../src/main/store');
const { Llm } = require('../src/main/llm');
const { Windows } = require('../src/main/windows');
const { TurnController } = require('../src/main/turn');
const { arrowLayout } = require('../src/main/geometry');
const ipc = require('../src/main/ipc');

const OUT = path.join(os.tmpdir(), 'handrail-smoke');
const failures = [];

/**
 * Run against a throwaway userData directory.
 *
 * The store writes settings, threads and the key to real files. Without this
 * the smoke test mutates the installed app's settings — and worse, it then
 * passes or fails depending on what a previous run left behind, which is how a
 * test starts lying to you. Must be set before `whenReady`.
 */
const SANDBOX = path.join(os.tmpdir(), 'handrail-smoke-data');
fs.rmSync(SANDBOX, { recursive: true, force: true });
app.setPath('userData', SANDBOX);

function check(name, condition, detail) {
  if (condition) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
    failures.push(name);
  }
}

/**
 * Wait for a window to finish loading, tolerating the load that already
 * happened. `once('did-finish-load')` alone deadlocks whenever the file loads
 * faster than the listener is attached — which for a local file is most of the
 * time, and the symptom is a test that hangs rather than one that fails.
 */
function loaded(win) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('window never finished loading')), 10000);
    win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(timer);
      reject(new Error(`load failed ${code}: ${desc}`));
    });
  });
}

async function shoot(win, name) {
  await new Promise((r) => setTimeout(r, 600));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  console.log(`  shot  ${name}.png`);
}

async function errorsIn(win) {
  return win.webContents.executeJavaScript('window.__errors || []');
}

function watchErrors(win) {
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      window.__errors = [];
      addEventListener('error', e => window.__errors.push(e.message));
      addEventListener('unhandledrejection', e => window.__errors.push('unhandled: ' + e.reason));
    `);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('    [renderer]', message);
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    check(`preload loads (${path.basename(file)})`, false, err.message);
  });
}

app.whenReady().then(() => run().catch((err) => {
  // Without this an async failure rejects into nothing and the run simply
  // stops mid-way, which reads as a hang rather than a failure.
  console.log(`\n  CRASH  ${err.message}`);
  console.log(err.stack);
  process.exitCode = 1;
  app.quit();
}));

async function run() {
  fs.mkdirSync(OUT, { recursive: true });

  const store = new Store();
  const llm = new Llm(() => store.getKey(), () => store.getSettings().model);
  const windows = new Windows(store);
  const turns = new TurnController({
    llm, store,
    getOverlay: () => windows.overlay,
    emit: (event) => {
      const win = windows.overlay;
      if (win && !win.isDestroyed()) win.webContents.send('hr:turn', event);
    },
    point: (payload) => windows.showArrow(payload),
    excludeFromCapture: () => windows.excludeFromCapture(),
  });
  ipc.register({ store, windows, turns, llm, onSetupComplete: () => {} });

  // --- store -------------------------------------------------------------
  console.log('\nstore');
  const settings = store.getSettings();
  check('settings have defaults', settings.capture === true && settings.pointing === true);
  check('keyHint is masked or empty', !settings.keyHint || /••••/.test(settings.keyHint), settings.keyHint);
  const thread = store.createThread();
  store.appendTurn(thread.id, { prompt: 'How do I add a cross dissolve?', summary: 'Task', at: Date.now() });
  check('thread auto-titles from first prompt',
    store.getThread(thread.id).title.startsWith('How do I'), store.getThread(thread.id).title);
  store.removeThread(thread.id);
  check('thread removed', !store.getThread(thread.id));

  // --- onboarding --------------------------------------------------------
  console.log('\nonboarding window');
  const onboarding = windows.showOnboarding();
  watchErrors(onboarding);
  await loaded(onboarding);
  await shoot(onboarding, '1-onboarding-intro');

  const bridgeOk = await onboarding.webContents.executeJavaScript(
    'typeof window.handrail === "object" && typeof window.handrail.setup.validateKey === "function"');
  check('preload bridge exposed', bridgeOk);

  await onboarding.webContents.executeJavaScript(
    "document.querySelector('[data-next]').click()");
  await shoot(onboarding, '2-onboarding-key');

  // Provider detection is what lets onboarding have one field and no dropdown.
  const detect = await onboarding.webContents.executeJavaScript(`(() => {
    const i = document.getElementById('key');
    i.value = 'sk-or-v1-' + 'a'.repeat(64);
    i.dispatchEvent(new Event('input'));
    return { text: document.getElementById('detected').textContent,
             enabled: !document.getElementById('key-continue').disabled };
  })()`);
  check('detects OpenRouter from key shape', detect.text.includes('OpenRouter'), detect.text);
  check('continue enabled by a valid shape', detect.enabled);
  await shoot(onboarding, '3-onboarding-key-detected');

  check('no onboarding renderer errors', (await errorsIn(onboarding)).length === 0,
    JSON.stringify(await errorsIn(onboarding)));
  // Hidden, not destroyed: destroying the only open window fires
  // window-all-closed and quits the app out from under the rest of the run.
  onboarding.hide();

  // --- overlay -----------------------------------------------------------
  console.log('\noverlay window');
  const overlay = windows.createOverlay();
  watchErrors(overlay);
  await loaded(overlay);
  windows.showOverlay();
  await shoot(overlay, '4-overlay-bar');

  const wired = await overlay.webContents.executeJavaScript(
    'typeof window.handrail.ask === "function" && typeof window.handrail.onTurn === "function"');
  check('overlay bridge exposed', wired);

  // Settings come over IPC from the real store — this is the round trip the
  // mock bridge cannot prove.
  const live = await overlay.webContents.executeJavaScript('window.handrail.settings.get()');
  check('settings round-trip over IPC', live && live.capture === true, JSON.stringify(live));
  check('key never crosses the bridge', live && !('key' in live) && !live.apiKey);

  await overlay.webContents.executeJavaScript("document.getElementById('toggle-threads').click()");
  await shoot(overlay, '5-overlay-threads');
  await overlay.webContents.executeJavaScript("document.getElementById('toggle-settings').click()");
  await shoot(overlay, '6-overlay-settings');

  // The window must track its content, not the other way round.
  const bounds = overlay.getBounds();
  check('overlay resized to content', bounds.width > 200 && bounds.width < 1200,
    `${bounds.width}x${bounds.height}`);

  check('no overlay renderer errors', (await errorsIn(overlay)).length === 0,
    JSON.stringify(await errorsIn(overlay)));

  // --- the transcript ----------------------------------------------------
  //
  // Driven by pushing hr:turn events straight at the real renderer, so this
  // exercises the shipping code rather than the mock bridge. The panel has to
  // ACCUMULATE: the first build replaced its contents every turn, so you could
  // never see what you had asked or scroll back to compare answers.
  console.log('\ntranscript');

  const feed = async (js) => overlay.webContents.executeJavaScript(js);
  const submit = async (text) => {
    await feed(`
      document.getElementById('input').value = ${JSON.stringify(text)};
      document.getElementById('bar').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await new Promise((r) => setTimeout(r, 900));
  };

  // Only the network is stubbed. Capture is off, so no screenshot is taken and
  // no key is needed, but the turn controller, the IPC contract and the
  // renderer are all the real ones.
  await store.setSettings({ capture: false, pointing: false, watching: false });
  await feed("document.getElementById('toggle-capture').click()");

  llm.respond = async ({ prompt }) => (
    /how do i|add /i.test(prompt)
      ? {
          kind: 'task',
          title: 'Add a cross dissolve between two clips',
          steps: [
            { text: 'Open the Effects panel from the Window menu.', hint: '', doneWhen: '', target: '' },
            { text: 'Select the **Razor tool** in the toolbar on the left.', hint: '', doneWhen: '', target: '' },
            { text: 'Cut both clips where they should overlap.', hint: '', doneWhen: '', target: '' },
            { text: 'Drag Cross Dissolve onto the join.', hint: 'Video Transitions → Dissolve.', doneWhen: '', target: '' },
          ],
        }
      : {
          kind: 'answer',
          markdown: "That red bar means Premiere hasn't rendered a preview yet, so playback "
            + "will stutter. It isn't an error.\n\nPress **Enter** with the timeline focused "
            + 'and it will render.',
        }
  );

  await submit('what is this red bar under my timeline?');
  await submit('how do I add a cross dissolve?');
  await shoot(overlay, '8-transcript');

  const counts = await feed(`({
    user: document.querySelectorAll('.msg--user').length,
    assistant: document.querySelectorAll('.msg--assistant').length,
    steps: document.querySelectorAll('.step').length,
    scrollable: document.getElementById('panel-body').scrollHeight >
                document.getElementById('panel-body').clientHeight,
    firstPromptStillThere: document.body.textContent.includes('red bar under my timeline'),
  })`);

  check('both prompts kept in the transcript', counts.user === 2, `${counts.user} user messages`);
  check('both replies kept', counts.assistant === 2, `${counts.assistant} replies`);
  check('the first question is still readable', counts.firstPromptStillThere);
  check('checklist rendered inside the transcript', counts.steps === 4, `${counts.steps} steps`);

  // --- answers must keep their structure ---------------------------------
  //
  // Every list the model wrote used to collapse into one grey paragraph with
  // stray hyphens in it, because the renderer only understood paragraphs. That
  // is most of why answers read as thin and generic — the structure was being
  // thrown away between the model and the screen.
  console.log('\nanswer formatting');

  llm.respond = async () => ({
    kind: 'answer',
    markdown: [
      "The note's path inside the vault is `03-Areas/Westcliff Scratch/Assignment Agent`.",
      '',
      'To find it on disk:',
      '',
      '- Right-click the file in the left sidebar',
      '- Click **Reveal in File Explorer**',
      '  - On macOS this reads **Show in system explorer**',
      '- Windows opens the folder containing the `.md` file',
      '',
      'If you want the vault root instead:',
      '',
      '1. Click the vault name at the bottom left',
      '2. Open **Manage vaults**',
      '3. The folder location is listed there',
    ].join('\n'),
  });

  await submit('where are these files on my disk?');

  const shape = await feed(`(() => {
    const last = [...document.querySelectorAll('.msg--assistant .prose')].pop();
    return {
      paragraphs: last.querySelectorAll('p').length,
      bullets: last.querySelectorAll(':scope > ul > li').length,
      nested: last.querySelectorAll('ul ul > li').length,
      numbered: last.querySelectorAll('ol > li').length,
      code: last.querySelectorAll('code').length,
      bold: last.querySelectorAll('strong').length,
      strayHyphen: /^\\s*-\\s/m.test(last.textContent),
    };
  })()`);

  check('top-level bullets render as a list', shape.bullets === 3, JSON.stringify(shape));
  check('nested bullets nest', shape.nested === 1, `${shape.nested}`);
  check('numbered lists render as a list', shape.numbered === 3, `${shape.numbered}`);
  check('inline code survives', shape.code >= 2, `${shape.code}`);
  check('bold survives', shape.bold >= 2, `${shape.bold}`);

  // Checklist steps are markdown too. They were rendered with textContent, so
  // every **bold** the model wrote showed up as literal asterisks — right in
  // the part of the UI the user is meant to follow.
  const stepMarkup = await feed(`(() => {
    const steps = [...document.querySelectorAll('.step__text')];
    return {
      count: steps.length,
      strong: steps.reduce((n, s) => n + s.querySelectorAll('strong').length, 0),
      rawAsterisks: steps.some((s) => s.textContent.includes('**')),
    };
  })()`);
  check('checklist steps render bold, not asterisks',
    stepMarkup.strong >= 1 && !stepMarkup.rawAsterisks, JSON.stringify(stepMarkup));
  check('no raw markdown left in the text', !shape.strayHyphen);
  await shoot(overlay, '9-formatted-answer');

  // --- follow-ups must not restart the task -------------------------------
  //
  // The reported bug: every prompt jumped straight to a checklist, so "now
  // what?" produced a second copy of the one already running and the thread
  // became a column of repeated headings. Two halves to it — the model was
  // never told a checklist existed, and asking anything killed the live task.
  console.log('\nconversation');

  const asked = [];
  llm.respond = async ({ prompt, activeTask }) => {
    asked.push({ prompt, sawActiveTask: !!activeTask });
    return { kind: 'answer', markdown: 'The Razor tool is the small blade icon.' };
  };

  const taskBefore = turns.task;
  check('a checklist is running', !!taskBefore, String(taskBefore && taskBefore.taskId));

  await submit('now what?');
  check('follow-up told the model a checklist is running',
    asked.length > 0 && asked[asked.length - 1].sawActiveTask);
  check('follow-up did not abandon the checklist', turns.task === taskBefore);

  const replayCounts = await feed(`({
    steps: document.querySelectorAll('.step').length,
    lastReply: document.querySelectorAll('.msg--assistant .prose p')[
      document.querySelectorAll('.msg--assistant .prose p').length - 1]?.textContent || '',
  })`);
  check('the follow-up got a conversational reply, not another checklist',
    replayCounts.lastReply.includes('blade icon'), replayCounts.lastReply);

  // Threads must reopen as a conversation, not as a list of titles.
  const openThread = store.listThreads()[0];
  await feed(`window.handrail.threads.open(${JSON.stringify(openThread.id)})`);
  const stored = store.getThread(openThread.id);
  const kinds = stored.turns.map((t) => t.kind);
  check('replies are stored in full, not as titles',
    stored.turns.some((t) => t.kind === 'answer' && t.markdown),
    JSON.stringify(kinds));
  check('checklists are stored with their steps',
    stored.turns.some((t) => t.kind === 'task' && Array.isArray(t.steps) && t.steps.length > 0));

  // Escape cancels the request; it must not throw the task away with it.
  turns.cancel();
  check('cancelling a request keeps the checklist', turns.task === taskBefore);
  turns.reset();
  check('reset does put the checklist away', turns.task === null);

  // --- an ordinary answer can point too ----------------------------------
  //
  // Pointing was tied to checklist steps, so a plain reply saying "right-click
  // the tab and choose Show in system explorer" could not draw an arrow at it.
  console.log('\npointing from a plain answer');

  const located = [];
  llm.locate = async ({ target }) => {
    located.push(target);
    return { found: true, label: target, box_2d: [400, 400, 440, 520], confidence: 0.9 };
  };
  llm.respond = async () => ({
    kind: 'answer',
    markdown: 'Right-click the tab and choose **Show in system explorer**. Windows opens the folder.',
    target: 'Show in system explorer in the right-click menu',
    completedStep: null,
  });

  await store.setSettings({ pointing: true });
  // Through the UI, not the store: `ask` sends the renderer's own idea of
  // whether to capture, so setting it only in main leaves the two disagreeing.
  await feed("document.getElementById('toggle-capture').click()");
  windows.showArrow(null);
  await submit('where is this file on disk?');
  await new Promise((r) => setTimeout(r, 700));

  check('a plain answer asked for a location', located.length > 0, JSON.stringify(located));
  check('a plain answer drew an arrow',
    !!windows.arrow && !windows.arrow.isDestroyed() && windows.arrow.isVisible());

  // The header names the conversation. It used to say "Handrail" forever.
  const header = await feed("document.getElementById('panel-title').textContent");
  check('header shows the thread name, not "Handrail"',
    header && header !== 'Handrail' && header.length > 3, JSON.stringify(header));

  await store.setSettings({ capture: false, pointing: false });
  windows.showArrow(null);

  // --- security boundaries ------------------------------------------------
  //
  // From the pre-landing review. Each of these was a real hole, so each gets a
  // check that fails if it reopens.
  console.log('\nsecurity boundaries');

  // The overlay renders model output. It must not be able to overwrite the key.
  const setupFromOverlay = await feed(`
    window.handrail.setup.saveKey('sk-or-v1-attacker')
      .then(() => 'ALLOWED')
      .catch(() => 'REFUSED')
  `);
  check('the overlay cannot call setup.saveKey', setupFromOverlay === 'REFUSED', setupFromOverlay);

  // openExternal takes a destination name, so a renderer cannot choose the URL.
  const openArbitrary = await feed(`
    window.handrail.setup.openExternal('https://example.com/attacker')
      .then(() => 'ALLOWED')
      .catch(() => 'REFUSED')
  `);
  check('openExternal refuses an arbitrary URL', openArbitrary === 'REFUSED', openArbitrary);

  // The window that renders untrusted output must be sandboxed.
  check('the overlay renderer is sandboxed',
    overlay.webContents.getLastWebPreferences().sandbox !== false,
    String(overlay.webContents.getLastWebPreferences().sandbox));

  // The key must never reach the renderer, in any form but a masked hint.
  const leaked = await feed(`(async () => {
    const s = await window.handrail.settings.get();
    const blob = JSON.stringify(s);
    return /sk-(or|ant)-v1-[A-Za-z0-9]{8,}/.test(blob) ? 'LEAKED' : 'MASKED';
  })()`);
  check('no unmasked key reaches the renderer', leaked === 'MASKED', leaked);

  // --- controls that have to actually work -------------------------------
  console.log('\ncontrols');

  // The send key looked like a button for several builds without being one.
  const send = await feed(`(() => {
    const b = document.getElementById('send');
    return b ? { tag: b.tagName, type: b.type } : null;
  })()`);
  check('the send key is a real submit button',
    send && send.tag === 'BUTTON' && send.type === 'submit', JSON.stringify(send));

  // Right-click a thread for rename and delete.
  await feed("document.getElementById('toggle-threads').click()");
  await new Promise((r) => setTimeout(r, 250));

  const menu = await feed(`(() => {
    const row = document.querySelector('.thread');
    if (!row) return { rows: 0 };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    const m = document.querySelector('.menu');
    return {
      rows: 1,
      items: m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : [],
      onScreen: m ? (m.getBoundingClientRect().left >= 0 && m.getBoundingClientRect().top >= 0) : false,
    };
  })()`);
  check('right-clicking a thread offers rename and delete',
    menu.items && menu.items.includes('Rename') && menu.items.includes('Delete'),
    JSON.stringify(menu));
  check('the menu stays on screen', menu.onScreen);

  // Renaming has to reach the store, not just the row.
  const before = store.listThreads()[0];
  await feed(`(() => {
    document.querySelector('.menu button').click();
    const input = document.querySelector('.thread__rename');
    input.value = 'Renamed by smoke test';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  check('rename is persisted',
    store.getThread(before.id).title === 'Renamed by smoke test',
    store.getThread(before.id).title);

  await feed("document.getElementById('toggle-threads').click()");

  // --- the overlay must not flicker --------------------------------------
  //
  // Capture used to hide the overlay and show it again, so the UI visibly
  // vanished and came back on every prompt. Stealth is forced OFF here because
  // that is the case that needs the work: with it on the windows are already
  // excluded from capture and nothing has to happen at all.
  console.log('\ncapture without flicker');

  store.setSettings({ capture: true, stealth: false });
  windows.applyStealth(false);
  windows.showOverlay();
  await new Promise((r) => setTimeout(r, 200));

  let everHidden = false;
  const watcher = setInterval(() => {
    if (!overlay.isDestroyed() && !overlay.isVisible()) everHidden = true;
  }, 10);

  await turns.ask({ text: 'what is on my screen?', capture: true, turnId: 'flicker-check' });
  await new Promise((r) => setTimeout(r, 1600));
  clearInterval(watcher);

  check('overlay stays visible through a capture', !everHidden);
  check('the screenshot still got taken', (await errorsIn(overlay)).length === 0);

  store.setSettings({ capture: false, stealth: true });
  windows.applyStealth(true);

  // --- arrow -------------------------------------------------------------
  console.log('\narrow window');
  const display = screen.getPrimaryDisplay();
  const target = {
    left: display.bounds.width * 0.62,
    top: display.bounds.height * 0.42,
    width: 110,
    height: 32,
  };
  const layout = arrowLayout(target, display.bounds);

  windows.showArrow({
    display,
    layout,
    label: 'Razor tool',
    instruction: 'Select the Razor tool in the toolbar on the left.',
  });
  await new Promise((r) => setTimeout(r, 800));
  check('arrow window created', !!windows.arrow && !windows.arrow.isDestroyed());

  if (windows.arrow) {
    await shoot(windows.arrow, '7-arrow');

    const drawn = await windows.arrow.webContents.executeJavaScript(
      "document.querySelectorAll('#stage svg path').length");
    check('arrow geometry drawn', drawn >= 4, `${drawn} paths`);

    const labelled = await windows.arrow.webContents.executeJavaScript(
      "!!document.querySelector('#stage .label')");
    check('arrow label placed', labelled);

    // Nothing may be drawn on top of the control itself. The ring used to be,
    // and it competed with the very thing the user was told to click.
    const rings = await windows.arrow.webContents.executeJavaScript(
      "document.querySelectorAll('#stage svg rect').length");
    check('no ring drawn over the control', rings === 0, `${rings} rects`);

    // The window covering the whole display is what made the machine feel
    // slow. Guard the size, not just the drawing.
    const ab = windows.arrow.getBounds();
    const coverage = (ab.width * ab.height) /
      (display.bounds.width * display.bounds.height);
    check('arrow window is a small region, not the display', coverage < 0.15,
      `${ab.width}x${ab.height} = ${(coverage * 100).toFixed(1)}% of screen`);
  }

  // The dismiss button is the only clickable thing on a click-through pane, so
  // it has to actually be there and actually be wired.
  const dismiss = await windows.arrow.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.label__close');
    if (!b) return { present: false };
    b.click();
    return { present: true };
  })()`);
  check('the indicator has a dismiss button', dismiss.present, JSON.stringify(dismiss));
  await new Promise((r) => setTimeout(r, 300));
  check('clicking dismiss hides the indicator', !windows.arrow.isVisible());

  windows.showArrow(null);
  check('arrow hides on clear', windows.arrow && !windows.arrow.isVisible());

  // --- result ------------------------------------------------------------
  console.log(`\nscreenshots: ${OUT}`);
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nall smoke checks passed');
  }

  windows.destroyAll();
  app.quit();
}

