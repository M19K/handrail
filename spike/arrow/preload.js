/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Arrow spike — preload.
 *
 * One channel, one direction. The overlay renderer is a drawing surface; it has
 * no reason to talk back, so nothing is exposed for it to do so.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  onArrow: (handler) => {
    ipcRenderer.on('spike:arrow', (_event, payload) => handler(payload));
  },
});
