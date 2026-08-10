/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified from OpenCluely (TechyCSR, Apache-2.0). This file has been changed;
 * see NOTICE and `git diff 7909792..HEAD` for what changed.
 */
/**
 * Handrail — preload bridge.
 *
 * The complete surface between main and renderer. See docs/IPC.md for the
 * contract and the reasoning behind its shape.
 *
 * This replaces upstream's two overlapping bridges (`electronAPI`, ~90 methods,
 * and `api`, a second channel allowlist) with one namespaced object and a
 * single event stream. The old surface was mostly speech and interview
 * machinery; none of it survives.
 *
 * Two things are deliberately absent and must stay absent:
 *   - the API key, after setup completes. Only a masked hint comes back.
 *   - screenshot image data. Captures go straight from the capture service to
 *     the provider, so the renderer has nothing to cache, log or leak.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Every renderer-initiated call goes through here, so failures look the same. */
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('handrail', {
  // --- a turn -------------------------------------------------------------
  ask: (payload) => call('hr:ask', payload),
  cancel: (turnId) => call('hr:cancel', turnId),

  /**
   * The single event stream. Everything that happens during a turn arrives
   * here tagged with `type`; the renderer switches on it once.
   *
   * Returns an unsubscribe function. The renderer is a long-lived window whose
   * panels mount and unmount, so leaking listeners here would accumulate over
   * a session rather than being cleared by navigation.
   */
  onTurn: (handler) => {
    const wrapped = (_event, payload) => {
      try {
        handler(payload);
      } catch (err) {
        // A renderer bug must not take down the stream for every later event.
        console.error('onTurn handler threw', err);
      }
    };
    ipcRenderer.on('hr:turn', wrapped);
    return () => ipcRenderer.removeListener('hr:turn', wrapped);
  },

  // --- steps --------------------------------------------------------------
  // Both directions exist because auto-advance can be wrong either way.
  completeStep: (taskId, index) => call('hr:step:complete', taskId, index),
  reopenStep: (taskId, index) => call('hr:step:reopen', taskId, index),

  // --- threads ------------------------------------------------------------
  threads: {
    list: () => call('hr:threads:list'),
    open: (id) => call('hr:threads:open', id),
    create: () => call('hr:threads:create'),
    rename: (id, title) => call('hr:threads:rename', id, title),
    remove: (id) => call('hr:threads:remove', id),
  },

  // --- settings -----------------------------------------------------------
  // Vision-capable models, fetched live from OpenRouter so the choice is not
  // limited to whatever ids were known when this was written.
  models: () => call('hr:models:list'),

  settings: {
    get: () => call('hr:settings:get'),
    set: (patch) => call('hr:settings:set', patch),
  },

  // --- window -------------------------------------------------------------
  window: {
    setState: (state) => call('hr:window:state', state),
    resize: (size) => call('hr:window:resize', size),
    beginDrag: () => call('hr:window:drag'),
    close: () => call('hr:window:close'),
    quit: () => call('hr:window:quit'),
    openSetup: () => call('hr:window:open-setup'),
  },

  // --- setup (onboarding window only) -------------------------------------
  setup: {
    validateKey: (key) => call('hr:setup:validate', key),
    saveKey: (key) => call('hr:setup:save', key),
    requestScreenAccess: () => call('hr:setup:screen-access'),
    // Puts the user on the exact Privacy & Security pane, and restarts
    // Handrail so macOS re-reads a permission granted after launch.
    openScreenSettings: () => call('hr:setup:open-screen-settings'),
    relaunch: () => call('hr:setup:relaunch'),
    complete: () => call('hr:setup:complete'),
    // A destination NAME, not a URL — see ipc.js. The renderer cannot choose
    // where the browser goes.
    openExternal: (destination) => call('hr:setup:open-external', destination),
  },
});
