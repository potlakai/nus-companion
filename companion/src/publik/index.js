'use strict';
// Everything Publik, behind one build switch. The rest of the Companion only asks this file:
// is the switch on, is publik answering on this computer, which key and base URL, and what a
// publik error means. Pure Node (no Electron at load), so llm.js and the tests can require it.
//
// The switch: `publik: true` in the packaged package.json, set by extraMetadata in
// electron-builder.companion.config.js. Off (or this folder left out of the build), the
// Companion starts with no gate and no publik provider, exactly like 0.1.16.
// NUS_PUBLIK=1 turns it on for a development start; nothing turns it off in a publik build.
const path = require('path');
const mod = require('./publik');

function on() {
  if (process.env.NUS_PUBLIK === '1') return true;
  try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).publik === true; } catch (_) { return false; }
}

// The person picked "Connect your plan" (choice "publik") on the gate or in Settings.
function choice() { const c = mod.readCredential(); return (c && c.choice) || null; }
function active() { return on() && mod.resolveProvider(null).kind === 'publik'; }
function provider() { const p = mod.resolveProvider(null); return p.kind === 'publik' ? { baseURL: p.baseURL, apiKey: p.apiKey } : null; }
function setChoice(c) { mod.setChoice(c === 'publik' || c === 'own_key' ? c : null); }

// Which tier answers. Everyday asks and the Smart switch; a vendor model name is never sent.
const TIERS = { fast: mod.MODELS.fast, smart: mod.MODELS.smart, hands: mod.MODELS.balanced };
function model(tier, requested) {
  if (typeof requested === 'string' && /^publik-(fast|balanced|smart|default)$/.test(requested)) return requested;
  return TIERS[tier] || TIERS.fast;
}

// publik API takes requests under 4 MB, pictures included. The Companion's screenshots are PNG at
// 1280 px; a busy screen can come near that, so a large one goes as JPEG (Electron, when there).
const MAX_IMAGE_CHARS = 3_000_000;
function prepareImage(dataUrl) {
  const s = String(dataUrl || '');
  if (s.length <= MAX_IMAGE_CHARS) return dataUrl;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromDataURL(s);
    for (const q of [80, 65, 50]) { const out = 'data:image/jpeg;base64,' + img.toJPEG(q).toString('base64'); if (out.length <= MAX_IMAGE_CHARS) return out; }
  } catch (_) { /* not in Electron: send it as it is */ }
  return dataUrl;
}

// A publik error, read from the OpenAI client's error (or a plain one). -> { kind, message, url }
// kind: 'balance' (402), 'signed_out' (401), 'offline', or ''.
function readError(e) {
  if (!e) return { kind: '', message: '', url: null };
  const status = Number(e.status) || 0;
  const body = e.error && typeof e.error === 'object' ? (e.error.error && typeof e.error.error === 'object' ? e.error.error : e.error) : null;
  if (status === 402) { const t = mod.topUpUrlFrom402({ error: body || {} }); return { kind: 'balance', message: t.message, url: t.url }; }
  if (status === 401) return { kind: 'signed_out', message: '', url: null };
  const text = String((e && e.message) || e);
  if (e.name === 'APIConnectionError' || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|Connection error/i.test(text)) return { kind: 'offline', message: '', url: null };
  return { kind: '', message: '', url: null };
}
// The words in the Knot's bubble. A 402 shows Publik's own message, our one line, and (as the
// bubble's button) Publik's one top-up link.
function errorLine(e) {
  const r = readError(e);
  if (r.kind === 'balance') return (r.message ? r.message.replace(/\s*$/, '') + ' ' : '') + 'Top up, or switch to your own key in Settings. Voice commands and reminders still work.';
  if (r.kind === 'signed_out') return 'publik signed this computer out. Restart Nūs to sign in again, or switch to your own key in Settings.';
  if (r.kind === 'offline') return 'publik is not reachable. Check your connection. Voice commands and reminders still work.';
  return '';
}

module.exports = { on, active, choice, provider, setChoice, model, TIERS, prepareImage, readError, errorLine, MAX_IMAGE_CHARS, module: mod };
