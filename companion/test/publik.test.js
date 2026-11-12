'use strict';
// Sign in with publik (companion/src/publik): what Publik's scan reads, the gate's place at
// start-up, the one build switch, the publik provider, and the words of a publik error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the module file carries what Publik\'s scan reads, in code', () => {
  const src = read('companion/src/publik/publik.js');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const s of ['/api/v1/installs', '/api/v1/telemetry', 'app_opened', 'APP_SLUG = "nus"']) assert.ok(code.includes(s), s);
});

test('the module version is the build version', () => {
  const mod = require('../src/publik/publik');
  const cfg = require('../../electron-builder.companion.config.js');
  assert.equal(mod.APP_VERSION, cfg.extraMetadata.version);
  assert.equal(mod.APP_SLUG, 'nus');
});

test('the gate is the first thing at start-up after the exam check, before any screen', () => {
  const main = read('src/main-companion.js');
  const ready = main.indexOf('app.whenReady().then(');
  const gate = main.indexOf('publik.module.ensureSignedIn(', ready);
  assert.ok(ready > 0 && gate > ready, 'gate inside whenReady');
  const exam = main.indexOf('standDown(exam); return;', ready);
  assert.ok(exam > 0 && exam < gate, 'the exam stand-down comes first');
  for (const later of ["open(path.join(userData, 'data'))", 'companionApp.initCompanion(', 'openHome();']) {
    const at = main.indexOf(later, ready);
    assert.ok(at > gate, later + ' comes after the gate');
  }
  // No way past it: the gate call is not behind a smoke, dev or environment check.
  const block = main.slice(main.lastIndexOf('if (publik) {', gate), gate);
  assert.doesNotMatch(block, /SMOKE|isPackaged|process\.env/);
});

test('one build switch: on in the release config, off in a plain development start', () => {
  const cfg = require('../../electron-builder.companion.config.js');
  assert.equal(cfg.extraMetadata.publik, true);
  assert.ok(cfg.files.includes('publik-app-token.txt'), 'the app token ships in the asar');
  assert.ok(!cfg.files.includes('!companion/src/publik/**'));
  const saved = process.env.NUS_PUBLIK; delete process.env.NUS_PUBLIK;
  try { assert.equal(require('../src/publik').on(), false); } finally { if (saved !== undefined) process.env.NUS_PUBLIK = saved; }
});

test('the switch is the only way in: off, createLLM keeps the own-key path', () => {
  const saved = { a: process.env.NUS_PUBLIK, k: process.env.PUBLIK_API_KEY };
  delete process.env.NUS_PUBLIK; process.env.PUBLIK_API_KEY = 'pk_live_test_only';
  try {
    const { createLLM } = require('../src/llm');
    const llm = createLLM({ provider: 'gemini', apiKeys: { gemini: 'g' }, models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' } } });
    assert.equal(llm.provider, 'gemini');
  } finally { restore(saved); }
});

test('switch on and publik chosen: the publik provider, tier names only', () => {
  const saved = { a: process.env.NUS_PUBLIK, k: process.env.PUBLIK_API_KEY };
  process.env.NUS_PUBLIK = '1'; process.env.PUBLIK_API_KEY = 'pk_live_test_only';
  try {
    const { createLLM } = require('../src/llm');
    const settings = { provider: 'gemini', apiKeys: {}, models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' } } };
    const fast = createLLM(settings);
    assert.equal(fast.provider, 'publik'); assert.equal(fast.ready, true); assert.equal(fast.model, 'publik-fast');
    assert.equal(createLLM({ ...settings, smart: true }).model, 'publik-smart');
    const pub = require('../src/publik');
    assert.equal(pub.model('fast', 'gemini-3.6-pro'), 'publik-fast', 'a vendor name is never sent');
    assert.equal(pub.model('fast', 'publik-balanced'), 'publik-balanced');
  } finally { restore(saved); }
});

test('an empty balance (402): Publik\'s message, one line, and the one top-up link', () => {
  const pub = require('../src/publik');
  const e = Object.assign(new Error('402 Not enough publik API balance.'), { status: 402, error: { message: 'Not enough publik API balance.', top_up_url: 'https://publikhq.com/wallet?top_up=1' } });
  const r = pub.readError(e);
  assert.equal(r.kind, 'balance'); assert.equal(r.url, 'https://publikhq.com/wallet?top_up=1');
  const { plainAskError } = require('../src/ask-error');
  const line = plainAskError('publik', e);
  assert.match(line, /^Not enough publik API balance\. Top up, or switch to your own key in Settings\./);
  assert.match(line, /Voice commands and reminders still work/);
  assert.doesNotMatch(line, /https?:/, 'the link rides on the Top up button, not in the text');
});

test('publik offline and signed out read as plain words', () => {
  const pub = require('../src/publik');
  assert.match(pub.errorLine(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })), /^publik is not reachable\. Check your connection\./);
  assert.match(pub.errorLine(Object.assign(new Error('401'), { status: 401 })), /Restart Nūs to sign in again/);
  assert.equal(pub.errorLine(new Error('something else')), '');
});

test('the gate window draws Publik\'s words exactly, with the Nūs lines above them', () => {
  const mod = require('../src/publik/publik');
  const { view, WORDING, WORDING_PICK, UPDATING, CHOICE_LINE } = require('../src/publik/gate-window');
  const sign = mod.gateScreen('sign_in', null);
  const v = view(sign, { updating: true });
  assert.equal(v.title, sign.title); assert.equal(v.body, sign.body); assert.deepEqual(v.buttons.map((b) => b.label), ['Sign in with publik']);
  const w = WORDING[WORDING_PICK];
  assert.deepEqual(v.nus, [w.headline, w.line, w.callout, ...v.steps, UPDATING].filter(Boolean));
  assert.equal(view(sign, { updating: false }).updating, '');
  const choose = view(mod.gateScreen('choose', { claim_state: 'claimed', account: null, plan: { kind: 'none', label: null }, balance_micros: 50000, top_up_url: 'x' }));
  assert.deepEqual(choose.buttons.map((b) => b.label), ['Connect your plan', 'Use my own key']);
  assert.equal(choose.privacy, CHOICE_LINE);
  const off = view(mod.gateScreen('unreachable', null));
  assert.equal(off.body, 'publik is not reachable. Check your connection.');
  assert.deepEqual(off.buttons.map((b) => b.label), ['Retry']);
  for (const line of [UPDATING, CHOICE_LINE]) assert.doesNotMatch(line, /—/, 'no em dashes');
});

test('big screenshots shrink under Publik\'s 4 MB limit only when needed', () => {
  const pub = require('../src/publik');
  const small = 'data:image/png;base64,' + 'A'.repeat(1000);
  assert.equal(pub.prepareImage(small), small);
});

function restore(saved) {
  if (saved.a === undefined) delete process.env.NUS_PUBLIK; else process.env.NUS_PUBLIK = saved.a;
  if (saved.k === undefined) delete process.env.PUBLIK_API_KEY; else process.env.PUBLIK_API_KEY = saved.k;
}
