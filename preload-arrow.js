/**
 * Handrail — arrow window preload.
 *
 * One channel, one direction. The arrow pane is a drawing surface: it is
 * click-through and cannot be interacted with, so it has nothing to say back.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('handrailArrow', {
  onDraw: (handler) => {
    ipcRenderer.on('hr:arrow', (_event, payload) => handler(payload));
  },
});
