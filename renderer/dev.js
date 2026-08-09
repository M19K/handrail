/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — renderer dev harness. DEVELOPMENT ONLY, not shipped.
 *
 * Opens overlay.html in a plain Electron window with no preload, so the mock
 * bridge takes over, then drives it through each state and writes a PNG of
 * every one via `capturePage()`.
 *
 * Why: the renderer's correctness is judged by eye, and there is no honest way
 * to claim a UI works without looking at a picture of it. Browsers block local
 * scripts on file:// and the real app is not wired yet, so this is the only
 * surface where the overlay can actually be seen. It also survives the wiring
 * work — a scripted screenshot run is a cheap regression check.
 *
 * Deliberately NOT transparent or frameless. This harness is for reviewing the
 * components; overlay behaviour on a real desktop is the app's job to prove.
 *
 *   npx electron renderer/dev.js
 *   npx electron renderer/dev.js --only=task
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = path.join(os.tmpdir(), 'handrail-renderer');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

/**
 * Each shot is a name, an action to run in the page, and how long to wait
 * before capturing. The waits are tuned to the mock bridge's own timings —
 * see mock-bridge.js.
 */
const SHOTS = [
  {
    name: '1-bar-default',
    note: 'Expanded bar, empty state. This is what launch looks like.',
    action: null,
    wait: 400,
  },
  {
    name: '2-collapsed',
    note: 'Collapsed pill.',
    action: `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`,
    wait: 400,
  },
  {
    name: '3-threads',
    note: 'Threads panel, grouped by recency.',
    action: `
      document.getElementById('pill').click();
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('toggle-threads').click();
    `,
    wait: 500,
  },
  {
    name: '4-settings',
    note: 'Settings panel. Copy is written as things you do.',
    action: `document.getElementById('toggle-settings').click()`,
    wait: 500,
  },
  {
    name: '5-answer-streaming',
    note: 'Quick question, mid-stream. Thinking dots in the bar.',
    action: `
      document.getElementById('toggle-settings').click();
      document.getElementById('input').value = 'What is this red bar under my timeline?';
      document.getElementById('bar').requestSubmit();
    `,
    wait: 900,
  },
  {
    name: '6-answer-complete',
    note: 'Quick answer, finished. Bold and inline code rendered without a markdown library.',
    action: null,
    wait: 1800,
  },
  {
    name: '7-task-checklist',
    note: 'Guided task. Step 1 active, arrow live, progress chip.',
    action: `
      document.getElementById('panel-close').click();
      await new Promise(r => setTimeout(r, 250));
      document.getElementById('input').value = 'How do I add a cross dissolve between two clips?';
      document.getElementById('bar').requestSubmit();
    `,
    wait: 2200,
  },
  {
    name: '8-task-advancing',
    note: 'The demo moment — steps ticking themselves with no user input.',
    action: null,
    wait: 6000,
  },
  {
    name: '9-error',
    note: 'Recoverable error with a retry.',
    action: `
      document.getElementById('panel-close').click();
      await new Promise(r => setTimeout(r, 250));
      document.getElementById('input').value = 'fail';
      document.getElementById('bar').requestSubmit();
    `,
    wait: 1600,
  },
];

async function run(win) {
  fs.mkdirSync(OUT, { recursive: true });
  const shots = only ? SHOTS.filter((s) => s.name.includes(only)) : SHOTS;

  for (const shot of shots) {
    if (shot.action) {
      // Wrapped in an async IIFE so shots can await inside their own action.
      await win.webContents.executeJavaScript(`(async () => { ${shot.action} })()`);
    }
    await new Promise((r) => setTimeout(r, shot.wait));

    const image = await win.webContents.capturePage();
    const file = path.join(OUT, shot.name + '.png');
    fs.writeFileSync(file, image.toPNG());
    console.log(`[dev] ${shot.name.padEnd(20)} ${shot.note}`);
  }

  // Surface anything the renderer logged. A silent renderer error would
  // otherwise be invisible in a screenshot that merely looks empty.
  const errors = await win.webContents.executeJavaScript('window.__devErrors || []');
  if (errors.length) {
    console.log('\n[dev] RENDERER ERRORS:');
    errors.forEach((e) => console.log('  ' + e));
  } else {
    console.log('\n[dev] no renderer errors');
  }

  console.log(`[dev] ${shots.length} screenshot(s) in ${OUT}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    backgroundColor: '#1B1E23',   // stand-in for "somebody else's screen"
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Collect renderer errors rather than letting them vanish into a devtools
  // console nobody is watching.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      window.__devErrors = [];
      window.addEventListener('error', e => window.__devErrors.push(e.message));
      window.addEventListener('unhandledrejection', e => window.__devErrors.push('unhandled: ' + e.reason));
    `);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  await win.loadFile(path.join(__dirname, 'overlay.html'));
  await new Promise((r) => setTimeout(r, 500));

  try {
    await run(win);
  } catch (err) {
    console.error('[dev] FAILED:', err.message);
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());
