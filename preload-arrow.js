/**
 * Handrail — arrow window preload.
 *
 * The arrow pane is click-through so the user can click the control it points
 * at. That also meant nothing on it could ever be clicked — including a dismiss
 * button, which is the obvious thing to want when guidance is in your way.
 *
 * The window therefore forwards mouse movement, and the renderer asks for
 * clicks to be accepted only while the cursor is actually over the label. Every
 * other pixel stays click-through. This is affordable now that the window
 * covers just the arrow rather than the whole display; when it was full-screen,
 * forwarding was the single biggest source of the lag users felt.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('handrailArrow', {
  onDraw: (handler) => {
    ipcRenderer.on('hr:arrow', (_event, payload) => handler(payload));
  },

  /** Accept clicks (true) or stay click-through (false). */
  setInteractive: (on) => ipcRenderer.send('hr:arrow:interactive', !!on),

  /** The user dismissed it. */
  dismiss: () => ipcRenderer.send('hr:arrow:dismiss'),
});
