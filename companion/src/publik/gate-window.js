'use strict';
// The Companion's window for Publik's sign-in gate (publik.js ensureSignedIn). Publik's own
// words and buttons are drawn exactly as the module gives them. Above them go a few Nūs lines:
// what publik is, that an update keeps everything, and what leaves the computer with each choice.
//
// Two things this window does that the bare module does not, and neither skips the gate:
// - When publik does not answer at start (Windows sign-in often beats Wi-Fi), it answers Retry by
//   itself every 5 seconds for up to 60 seconds before it shows "publik is not reachable". The
//   module still decides; this only waits before drawing the same screen.
// - Closing the window quits the Companion: there is no way past the gate but signing in.
const path = require('path');
// Electron is loaded when the window is made, so the words below can be tested in plain Node.

const QUIET_RETRY_MS = 60_000, QUIET_STEP_MS = 5_000;

const INTRO = 'Nūs signs in with publik. publik is where Nūs is listed. It can also run the AI that answers you, so you can ask with no key. Signing in is free. When you link your account you get a few free asks to start.';
const UPDATING = 'Signing in is new in 0.1.18. Everything you set up is still here. Your own Gemini key or Claude Code still works: pick Use my own key after you sign in.';
const CHOICE_LINE = 'With publik, your question and a picture of your screen go to publik\'s AI to answer. With your own key they go to your AI company, as before. Voice commands, reminders and your notes stay on this computer either way.';

// Pure: what the window shows for one of the module's screens. Exported for tests.
function view(screen, opts = {}) {
  const lines = [];
  if (screen.id === 'sign_in') { lines.push(INTRO); if (opts.updating) lines.push(UPDATING); }
  if (screen.id === 'choose') lines.push(CHOICE_LINE);
  return { title: screen.title, nus: lines, body: screen.body, note: screen.note || '', buttons: screen.buttons.map((b) => ({ action: b.action, label: b.label })) };
}

function createGateUI(opts = {}) {
  const { BrowserWindow, ipcMain, shell, app } = require('electron');
  const started = Date.now();
  let win = null, shown = false, pending = null;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({ width: 480, height: 460, resizable: false, minimizable: true, maximizable: false, show: false, title: 'Sign in with publik',
      backgroundColor: '#0b0d12', autoHideMenuBar: true, icon: opts.icon,
      webPreferences: { preload: path.join(__dirname, 'gate-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.loadFile(path.join(__dirname, 'gate.html'));
    // No way past the gate but signing in: closing it ends the app.
    win.on('closed', () => { win = null; if (pending) app.quit(); });
    return win;
  }
  const onPress = (event, action) => {
    if (!win || event.sender !== win.webContents || !pending) return;
    const p = pending; pending = null;
    if (p.buttons.includes(action)) p.resolve(action); else pending = p;
  };
  ipcMain.on('publik-gate:press', onPress);

  return {
    async show(screen, signal) {
      if (screen.id === 'unreachable' && !shown && now() - started < QUIET_RETRY_MS) {
        await sleep(QUIET_STEP_MS);
        if (signal && signal.aborted) return new Promise(() => {});
        return 'retry';
      }
      const w = ensureWindow();
      const draw = () => { try { w.webContents.send('publik-gate:screen', view(screen, opts)); } catch (_) {} };
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', draw); else draw();
      if (!shown) { w.once('ready-to-show', () => w.show()); if (!w.webContents.isLoading()) w.show(); shown = true; }
      return new Promise((resolve) => {
        pending = { resolve, buttons: screen.buttons.map((b) => b.action) };
        if (signal) signal.addEventListener('abort', () => { if (pending && pending.resolve === resolve) pending = null; }, { once: true });
      });
    },
    openUrl(url) { if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url)); },
    // The gate is passed: close the window without quitting.
    close() { pending = null; ipcMain.removeListener('publik-gate:press', onPress); if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}

module.exports = { createGateUI, view, INTRO, UPDATING, CHOICE_LINE };
