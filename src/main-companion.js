const worker = process.argv.find(a => /capture-worker\.js$/i.test(a));
if (worker) { require(worker); return; }

const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerMonitor, net } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
// Only scripts/update-test/ builds carry this block; a test asserts the release config does not.
const testBuild = (() => { try { return require('../package.json').nusBuild || {}; } catch { return {}; } })();
function dataDirFromArgv(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg.startsWith('--data-dir=')) return arg.slice('--data-dir='.length);
    if (arg === '--data-dir' && argv[i + 1]) return argv[i + 1];
  }
  if (process.env.NUS_COMPANION_DATA_DIR) return process.env.NUS_COMPANION_DATA_DIR;
  // A local update test build keeps its own profile, whoever starts it (the
  // installer's restart does not pass our environment on). scripts/update-test.
  return testBuild.dataDir || null;
}
app.setName('Nus Companion');
const dir = dataDirFromArgv();
app.setPath('userData', dir ? path.resolve(dir) : path.join(app.getPath('appData'), 'Nus Companion'));
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
let home = null, companion = null, folders = null, databaseReady = false;
app.on('second-instance', () => { if (app.isReady()) { openHome(); try { stats.engaged(); } catch (_) { /* stats may not exist yet */ } } });
const crashHandlers = require('./crash').installCrashHandlers(app, dialog);
const { createQuitGuard } = require('./quit-guard');
const companionApp = require('../companion');
const store = require('../companion/src/store');
store.setStandalone(true);
const ai = require('./ai');
const secrets = require('./secrets');
const sttLocal = require('./stt-local');
const { open, api, setSaveStateListener } = require('./db');
const { createLLM } = require('../companion/src/llm');
const routines = require('../companion/src/reflex/routines');
const { INTENTS } = require('../companion/src/reflex/router');
const { normalizeFeeds } = require('../companion/src/reflex/focus-guard');
const { createFolders, inside } = require('../companion/home/folders');
const solveBudget = require('../companion/src/guide/solve-budget');
const { createExamGuard, MESSAGE: EXAM_MESSAGE } = require('../companion/src/win/examguard');
const { createStats } = require('../companion/src/stats');
const { createFeedback } = require('../companion/src/feedback');
const { createAccount, SUPABASE_URL } = require('../companion/src/account');
const { createLink } = require('../companion/src/account-link');
const { createSync } = require('../companion/src/settings-sync');
const { createEntitlement } = require('../companion/src/entitlement');
const accountOffer = require('../companion/src/account-offer');
const { createUpdateCheck } = require('../companion/src/updates');
const { createChannel, channelConfig, safeLink } = require('../companion/src/channel');
const { createOneClick } = require('../companion/src/one-click');
const getStarted = require('../companion/src/get-started');
const tourMod = require('../companion/src/tour');
const userData = app.getPath('userData');
const routinesFile = path.join(userData, 'reflex-routines.json');
const notesFile = path.join(userData, 'companion', 'notes.md');
const homeFile = path.join(__dirname, '..', 'companion', 'home', 'index.html');
const SMOKE = process.argv.includes('--smoke');
const ALLOWED_EXTERNAL = new Set(['https://typesafe.ai', 'https://aistudio.google.com/apikey', 'https://console.anthropic.com', 'https://github.com/potlakai/nus-desktop/releases']);
function send(channel, value) { if (home && !home.isDestroyed()) home.webContents.send(channel, value); }
// Packaged: the version electron-builder stamped. A dev run reports Electron's
// own version from app.getVersion(), so read the build config instead.
function companionVersion() {
  if (app.isPackaged) return app.getVersion();
  try { return require('../electron-builder.companion.config').extraMetadata.version + '-dev'; } catch { return app.getVersion(); }
}
// Anonymous usage stats (contract: vault growth-os/TELEMETRY-CONTRACT.md). The
// only server this build talks to besides the AI providers and TypeSafe, and
// only when packaged (or NUS_STATS=1), switched on, and NUS_STATS is not 0.
// Session length (contract 2026-10-15 b): active minutes, sampled against the
// system idle clock, sent at quit and at each UTC day change. NUS_STATS_DEV=1 or
// <userData>/dev-install.txt marks this as one of Pranav's own installs.
// Contract (c), 2026-10-17: which feature answered and how it ended, feature
// timers, the first-run steps, a crash count. Never the words, never the error.
const stats = createStats({ userData, settings: { get: () => store.getSettings(), set: patch => store.setSettings(patch) },
  appVersion: companionVersion(), platform: process.platform, packaged: app.isPackaged, ...(testBuild.statsUrl ? { url: testBuild.statsUrl } : {}),
  idleSeconds: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return 0; } } });
crashHandlers.setOnCrash(() => stats.crash());
function anyKeySaved() { try { return Object.values(store.getSettings().apiKeys || {}).some(Boolean); } catch { return false; } }
// Feedback to Pranav (companion/src/feedback.js): "tell Pranav ...", a
// one-tap reaction after the 1st, 5th and 25th ask, a day-3 check-in. Notes
// wait in the outbox until submit-feedback answers. The install id rides along
// only while stats are on.
const feedback = createFeedback({ userData, appVersion: companionVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged,
  installId: () => (stats.enabled() ? stats.installId() : null) });
// The optional account (companion/src/account.js, docs/accounts-b.md). Built
// once secrets.init has run; a signed-out Companion never touches the network
// for it. The browser only ever opens Supabase's own authorize page.
let account = null;
function getAccount() {
  if (!account) account = createAccount({
    secrets: { available: () => secrets.isAvailable(), get: k => secrets.getSecret(k), set: (k, v) => secrets.setSecret(k, v), remove: k => secrets.deleteSecret(k) },
    openExternal: url => { if (!String(url).startsWith(SUPABASE_URL + '/auth/v1/authorize?')) throw new Error('Sign-in link is not allowed.'); return shell.openExternal(url); },
    onChange: () => send('home:account', accountState()) });
  return account;
}
// The link (companion/src/account-link.js): the install id goes to
// link-install only while the stats switch is on.
let accountLink = null;
function getLink() {
  if (!accountLink) accountLink = createLink({ account: getAccount(), installId: () => (stats.status().enabled ? stats.installId() : null),
    memory: { get: () => (databaseReady ? api.getPreferences().account_link || null : null), set: value => { if (databaseReady) api.setPreference('account_link', value); } },
    appVersion: companionVersion(), platform: process.platform });
  return accountLink;
}
// Selective settings sync (companion/src/settings-sync.js): off until ticked.
// What comes from the account goes through the same doors as Home's own
// switches: settingsPatch, the talk-key rebind, and Fable only once it is
// installed on this computer.
let settingsSync = null, syncTimer = null, applyingSync = false;
function getSync() {
  if (!settingsSync) settingsSync = createSync({ account: getAccount(), settings: () => store.getSettings(),
    memory: { get: () => (databaseReady ? api.getPreferences().account_sync || null : null), set: value => { if (databaseReady) api.setPreference('account_sync', value); } },
    apply: async patch => {
      applyingSync = true;
      try {
        const { ptt, voice, ...rest } = patch;
        console.log('[settings] from the account: ' + Object.keys(patch).join(', ') + (patch.hands === false ? ' (hands off)' : ''));
        if (ptt) companion.setPttShortcut(ptt);
        if (voice === 'system' || (voice === 'fable' && companion.voiceStatus && companion.voiceStatus().installed)) rest.voice = voice;
        if (Object.keys(rest).length) settingsPatch(rest);
      } finally { applyingSync = false; }
      send('home:state', companion.status());
    } });
  return settingsSync;
}
// A change in Home goes up five seconds later, batched; nothing while signed
// out or with sync off.
function scheduleSync() {
  if (applyingSync || !account || !getAccount().status().signedIn || !getSync().status().syncOn) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => getSync().sync().then(() => send('home:account', accountState())).catch(() => {}), 5000);
  if (syncTimer.unref) syncTimer.unref();
}
// The plan (companion/src/entitlement.js): shown on the card, gates nothing.
let entitlement = null;
function getEntitlement() {
  if (!entitlement) entitlement = createEntitlement({ account: getAccount(), appVersion: companionVersion(),
    secrets: { available: () => secrets.isAvailable(), get: k => secrets.getSecret(k), set: (k, v) => secrets.setSecret(k, v), remove: k => secrets.deleteSecret(k) } });
  return entitlement;
}
function accountState() {
  const s = getAccount().status();
  return { ...s, ...getLink().status(), ...getSync().status(), ...getEntitlement().status(), offer: databaseReady && accountOffer.shouldOffer(api.getPreferences(), s.signedIn) };
}
// The offer counts days the Companion was opened: a launch, or a Home window.
function countAccountOpen() {
  if (SMOKE || !databaseReady) return;
  const patch = accountOffer.countOpen(api.getPreferences());
  if (patch) for (const [key, value] of Object.entries(patch)) api.setPreference(key, value);
}
function notes() { try { return fs.readFileSync(notesFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } }
// Once a day: is there a newer Companion (companion/src/updates.js)? The
// result sits in the preferences table; the Home window offers Download.
let updateCheck = null;
function getUpdateCheck() {
  if (!updateCheck) updateCheck = createUpdateCheck({ current: app.isPackaged ? app.getVersion() : companionVersion().replace(/-dev$/, ''), store: { get: key => (databaseReady ? api.getPreferences()['companion_' + key] : null), set: (key, value) => { if (databaseReady) api.setPreference('companion_' + key, value); } }, log: m => console.log('[updates] ' + m) });
  return updateCheck;
}
// The signed channel file (companion/src/channel.js, docs/update-channel.md): the
// newest version and short notes, one GET a day, and the one-click update that
// only runs an installer whose size and hash that file signed.
let channel = null, oneClick = null;
function getChannel() {
  if (!channel) channel = createChannel({ current: app.isPackaged ? app.getVersion() : companionVersion().replace(/-dev$/, ''), store: { get: key => (databaseReady ? api.getPreferences()['companion_' + key] : null), set: (key, value) => { if (databaseReady) api.setPreference('companion_' + key, value); } },
    cfg: channelConfig(require('../package.json')), log: m => console.log('[channel] ' + m) });
  return channel;
}
function getOneClick() {
  if (!oneClick) oneClick = createOneClick({ channel: getChannel(), dir: path.join(userData, 'updates'),
    canRun: app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR,
    fetchImpl: (url, opts) => net.fetch(url, opts), spawnImpl: spawn, quit: () => app.quit(),
    beforeInstall: version => stats.noteOneClick(version), log: m => console.log('[update] ' + m),
    onState: s => { if (companion && companion.channelProgress) companion.channelProgress(s); if (home && !home.isDestroyed()) send('home:update', updateState()); } });
  return oneClick;
}
// What the dashboard card reads: the check, whether one click can do it, and how far along it is.
function updateState() {
  const u = getUpdateCheck().state();
  const oc = getOneClick();
  const signed = getChannel().update();
  const same = !!(signed && u.available && signed.version === u.available.version);
  return { ...u, oneClick: same && oc.available(), progress: oc.state().phase === 'idle' ? null : oc.state() };
}
// The daily fetch. When the signed file answers, GitHub is not asked; when it
// cannot be reached, or has never been published, the old check still fills the card.
async function channelCheck() {
  const r = await getChannel().check().catch(() => ({ ok: false }));
  if (r.ok && r.fetched) { const u = getChannel().update(); getUpdateCheck().adopt(u ? { version: u.version, url: u.url } : { version: null }); }
  else if (!r.ok) await getUpdateCheck().check();
  send('home:update', updateState());
}
function lifestyleSnapshot() {
  const keeps = companion ? companion.keeps() : [];
  const grouped = new Map();
  for (const item of keeps) { const name = item.app.process; if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(item.task); }
  return { schema_version: 1, generated_at: new Date().toISOString(), product: 'Nūs Companion',
    folders: (folders ? folders.list() : []).map(f => ({ label: f.label, files: f.files, enabled: f.enabled })),
    routines: routines.load(routinesFile).map(r => ({ name: r.name, steps: r.steps.length })),
    keeps: [...grouped].map(([app, tasks]) => ({ app, tasks })),
    sessions_today: api.listCompanionSessions().filter(s => new Date(s.started_at).toDateString() === new Date().toDateString()).length,
    notes: notes().length, next_moves: [] };
}
function openHome() {
  if (home && !home.isDestroyed()) { if (home.isMinimized()) home.restore(); home.show(); home.focus(); return home; }
  home = new BrowserWindow({ width: 1100, height: 720, minWidth: 800, minHeight: 560, backgroundColor: '#0b0d12', title: 'Nūs Dashboard',
    webPreferences: { preload: path.join(__dirname, '..', 'companion', 'home', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  home.setMenuBarVisibility(false);
  // The Companion window follows the same "hidden from screen sharing" switch
  // as the Knot; until 0.1.2 it was captured while the overlay was not.
  // The dashboard is never hidden from screen sharing (Pranav, 2026-11-03); only the Knot follows the switch.
  home.setContentProtection(false);
  home.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  home.webContents.on('will-navigate', e => e.preventDefault());
  // First-run steps for the leak map: the window the install saw first, and
  // whether it closed with no key and no ask. Each step is counted once ever.
  const firstWindow = !api.getPreferences().home_seen;
  if (firstWindow) stats.onboardingStep('welcome_seen');
  // Get started (companion/src/get-started.js) is for an install whose very
  // first window is this one; an upgrade has home_seen already and never sees it.
  for (const [key, value] of Object.entries(tourMod.onFirstWindow(api.getPreferences()))) api.setPreference(key, value);
  countAccountOpen();
  home.on('closed', () => {
    home = null;
    if (stats.status().asked) return;
    if (!anyKeySaved()) stats.onboardingStep('key_skipped');
    stats.onboardingStep('first_window_closed');
  });
  home.loadFile(homeFile);
  api.setPreference('home_seen', true);
  return home;
}
function publicSettings() {
  const s = store.getSettings();
  const { apiKeys, ...rest } = s;
  return { ...rest, keys: Object.fromEntries(Object.entries(apiKeys || {}).map(([k,v]) => [k, !!v])), openMic: s.openMic ?? (process.env.NUS_REFLEX_OPENMIC === '1') };
}
// One key store. The Companion's settings (companion/src/store.js, encrypted)
// hold every key; the desktop-side Claude client (src/ai.js, shared with the
// student app) reads its Anthropic key from secrets.js, so that copy is kept
// as a mirror of the store, written here and only here.
function mirrorAnthropicKey(value) {
  const key = String(value || '').trim();
  try { if (key) ai.setApiKey(key); else ai.clearApiKey(); } catch (e) { console.log('[nus-companion] anthropic key mirror failed:', e.message); }
}
// 0.1.1 profiles saved the Anthropic key only in secrets.js; carry it into
// the store once so the checklist and the provider switch can see it.
function adoptLegacyAnthropicKey() {
  const s = store.getSettings();
  if (s.apiKeys && s.apiKeys.anthropic) { mirrorAnthropicKey(s.apiKeys.anthropic); return; }
  const legacy = secrets.getSecret('anthropic_api_key');
  if (legacy) store.setSettings({ apiKeys: { anthropic: legacy } });
}
// Start with Windows: a login item that runs this exe with --autostart. Only a
// packaged build registers one; a dev run would register electron.exe.
function applyAutostart(on) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: ['--autostart'] }); } catch (e) { console.log('[autostart] ' + e.message); }
}
function settingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const clean = {};
  for (const key of ['openMic', 'persistTranscripts', 'saveAudio', 'speakReplies', 'smart', 'proactive', 'hideFromCapture', 'sounds', 'focusGuard', 'tasks', 'hands', 'knotIsland']) if (typeof patch[key] === 'boolean') clean[key] = patch[key];
  if (typeof patch.channelMessages === 'boolean') clean.channelMessages = patch.channelMessages;
  if (typeof patch.startWithWindows === 'boolean') clean.startWithWindows = patch.startWithWindows;
  // The feed titles the focus guard closes: short words, at most 20, deduplicated.
  if (Array.isArray(patch.focusGuardFeeds) || typeof patch.focusGuardFeeds === 'string') clean.focusGuardFeeds = normalizeFeeds(patch.focusGuardFeeds);
  // The Knot's voice: the system one, or a named local voice (companion/src/voice).
  if (patch.voice === 'system' || patch.voice === 'fable') clean.voice = patch.voice;
  if (patch.apiKeys && typeof patch.apiKeys === 'object') {
    clean.apiKeys = {};
    for (const key of ['typesafe','gemini','anthropic','openai','nvidia']) if (typeof patch.apiKeys[key] === 'string' && patch.apiKeys[key].length <= 4096) clean.apiKeys[key] = patch.apiKeys[key].trim();
    // The answer provider follows the key just pasted; a Gemini key wins because
    // it is the free one, an Anthropic key takes over only when no Gemini key exists.
    const current = store.getSettings().apiKeys || {};
    if (clean.apiKeys.gemini) clean.provider = 'gemini';
    else if (clean.apiKeys.anthropic && !current.gemini) clean.provider = 'anthropic';
    else if (clean.apiKeys.gemini === '' && (clean.apiKeys.anthropic || current.anthropic) && store.getSettings().provider === 'gemini') clean.provider = 'anthropic';
  }
  if (Number.isFinite(patch.audioRetentionDays)) clean.audioRetentionDays = Math.max(1, Math.min(365, Math.round(patch.audioRetentionDays)));
  if (['tl','tr','bl','br'].includes(patch.knotCorner)) clean.knotCorner = patch.knotCorner;
  if (patch.knotDisplayId === null || screen.getAllDisplays().some(d => d.id === patch.knotDisplayId)) clean.knotDisplayId = patch.knotDisplayId;
  companion.setSettings(clean);
  if (typeof clean.startWithWindows === 'boolean') applyAutostart(clean.startWithWindows);
  if (clean.apiKeys && Object.prototype.hasOwnProperty.call(clean.apiKeys, 'anthropic')) mirrorAnthropicKey(clean.apiKeys.anthropic);
  // A pasted key counts as key_connected (the provider name only, never the key).
  for (const [provider, value] of Object.entries(clean.apiKeys || {})) if (value) stats.keyConnected(provider);
  // The stats switch is the one setting the stats module writes itself: off
  // sends a last stats_off first, so it is not part of the plain patch above.
  if (typeof patch.sendStats === 'boolean') stats.setEnabled(patch.sendStats);
  scheduleSync();
  return publicSettings();
}
// The checklist: one short call per key, so a person knows which one is
// wrong before the Knot has to fail in front of them. Errors are clipped and
// never echo the key.
function scrub(text, keys) {
  let out = String(text || '').slice(0, 400);
  for (const k of keys) if (k && k.length > 6) out = out.split(k).join('[key]');
  return out;
}
async function timed(fn) {
  const t0 = Date.now();
  try { const r = await fn(); return { ok: r === true || (r && r.ok !== false && !r.error), ms: Date.now() - t0, error: r && r.error ? String(r.error) : '' }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }; }
}
async function testKeys(which) {
  const s = store.getSettings();
  const keys = Object.values(s.apiKeys || {});
  const jev = require('../companion/src/reflex/jev');
  const ping = provider => async () => {
    const llm = createLLM({ ...s, provider, smart: false });
    if (!llm.ready) return { error: 'no key' };
    const text = await llm.complete({ system: 'Reply with exactly the word OK.', turns: [{ role: 'user', text: 'ping' }], maxTokens: 8 });
    return /ok/i.test(String(text)) ? { ok: true } : { ok: true, error: '' };
  };
  const tests = {
    typesafe: () => jev.ready() ? timed(() => jev.systemOne({ state: { ping: 'ping' }, questions: { ok: jev.noul('Is the state a ping?') }, timeoutMs: 4000, retries: 0 })) : { ok: false, ms: 0, error: 'no key' },
    gemini: () => s.apiKeys.gemini ? timed(ping('gemini')) : { ok: false, ms: 0, error: 'no key' },
    nvidia: () => s.apiKeys.nvidia ? timed(ping('nvidia')) : { ok: false, ms: 0, error: 'no key' },
    anthropic: () => s.apiKeys.anthropic ? timed(ping('anthropic')) : { ok: false, ms: 0, error: 'no key' },
    cli: async () => (await ai.status()).cli ? timed(() => ai.testConnection()) : { ok: false, ms: 0, error: 'not installed' },
  };
  // One row at a time: Claude Code alone takes seconds, and a missing key
  // should answer at once.
  const names = tests[which] ? [which] : Object.keys(tests);
  const out = {};
  // Each failure gets one plain sentence (Apple review fix 4); the scrubbed raw
  // text stays as `error` for the Details line.
  for (const k of names) { out[k] = await tests[k](); out[k].error = scrub(out[k].error, keys); if (!out[k].ok && out[k].error) out[k].message = getStarted.plainKeyError(k, out[k].error); }
  return out;
}
// Get started, step 1. Claude Code: one real answer through the pool proves it
// is installed and signed in. Gemini: the pasted key answers one word before it
// is saved, so a bad key never becomes the answer source.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer));
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!home || home.isDestroyed() || event.sender !== home.webContents || event.senderFrame !== home.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(homeFile).href) throw new Error('Untrusted home caller.');
    return fn(...args);
  });
}
function registerHomeIpc() {
  // The first window paints the stats notice: one step, counted once.
  handle('home:status', async () => ({ ...companion.status(), ai: await ai.status(), llmReady: createLLM(store.getSettings()).ready, version: companionVersion(),
    ...(stats.status().firstRun ? (stats.onboardingStep('stats_notice_seen'), {}) : {}),
    hotkeys: { ptt: companion.status().ptt.accelerator, assist: store.getSettings().shortcuts.assist, select: 'Ctrl+Shift+T', toggle: 'Ctrl+Shift+Space', panic: 'Ctrl+Shift+X' },
    displays: screen.getAllDisplays().map(d => ({ id: d.id, label: d.label || d.size.width + ' × ' + d.size.height })),
    contentProtection: companion.status().captureHidden !== false,
    captureForcedOff: Boolean(process.env.JARVIS_NO_PROTECT || process.env.NUS_NO_PROTECT),
    stats: stats.status(),
    usage: companion.usage ? companion.usage(1) : null,
    update: (() => { const u = updateState(); if (u.available && !u.dismissed) stats.updateOffered('card', u.available.version); return u; })(),
    voice: companion.voiceStatus ? companion.voiceStatus() : null,
    assignmentSpend: solveBudget.summary(process.env.NUS_ASSIGNMENT_BUDGET_FILE || path.join(userData, 'companion', 'assignment-budget.json')) }));
  handle('home:settings:get', publicSettings);
  handle('home:settings:set', settingsPatch);
  // "Where did you hear about Nūs?": one click, one event, then the row is gone for good.
  // Share my week: the picture the dashboard drew, to the clipboard and to
  // Pictures\Nūs. Only a PNG data URL is accepted; nothing is uploaded.
  handle('home:share-card', dataUrl => {
    const url = String(dataUrl || '');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url) || url.length > 12e6) return { ok: false };
    const { clipboard, nativeImage } = require('electron');
    const img = nativeImage.createFromDataURL(url);
    if (img.isEmpty()) return { ok: false };
    clipboard.writeImage(img);
    let file = '';
    try { const dir = path.join(app.getPath('pictures'), 'Nūs'); fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, 'my-week-' + new Date().toISOString().slice(0, 10) + '.png'); fs.writeFileSync(file, img.toPNG()); } catch (_) { file = ''; }
    stats.hookUsed('share_card');
    return { ok: true, file };
  });
  handle('home:my-nus', () => { const s = companion.myNus(); stats.hookShown('my_nus'); return s; });
  handle('home:stats:source', source => { stats.sourceAnswer(String(source || 'skipped')); return stats.status(); });
  handle('home:keys:test', which => testKeys(String(which || '')));
  // Feedback page: the person's words, a kind, and an optional reply address,
  // sent (or queued) on Send. Nothing else from the app rides along.
  handle('home:feedback:send', p => feedback.submit({ message: String((p && p.message) || ''), kind: String((p && p.kind) || 'other'), email: String((p && p.email) || ''), collector: 'home' }));
  handle('home:feedback:status', () => feedback.status());
  // The optional account: Sign in with Google resolves when the browser comes
  // back (or the five minute attempt ends); Home stays usable meanwhile.
  handle('home:account:status', accountState);
  handle('home:account:signin', async () => {
    const r = await getAccount().signIn();
    if (r.ok) { openHome(); getLink().forget(); await getLink().link().catch(() => {}); await getEntitlement().refresh().catch(() => {}); }
    return { ...accountState(), error: r.ok || r.cancelled ? '' : r.error };
  });
  handle('home:account:cancel', () => { getAccount().cancelSignIn(); return accountState(); });
  handle('home:account:signout', async () => { await getAccount().signOut(); getEntitlement().clear(); return accountState(); });
  handle('home:account:unlink', async () => { await getLink().unlink(); return accountState(); });
  handle('home:account:link', async () => { getLink().forget(); await getLink().link(); return accountState(); });
  handle('home:account:sync', async on => { await getSync().setOn(on === true); return accountState(); });
  handle('home:account:sync-now', async () => { await getSync().sync(); return accountState(); });
  handle('home:account:delete', async () => { const r = await getLink().deleteAccount(); if (r.ok) { await getSync().setOn(false); getEntitlement().clear(); } return { ...accountState(), deleted: r.ok, error: r.ok ? '' : r.error }; });
  handle('home:account:dismiss', () => { api.setPreference('account_offer_dismissed', true); return accountState(); });
  // The tour (companion/src/tour.js): where it stands, start it, or skip it for good.
  handle('home:tasks:list', () => companion.tasksHome());
  handle('home:task:action', p => companion.taskAction(p));
  handle('home:project:continue', id => companion.projectContinue(id));
  handle('home:knot:word', () => companion.knotWord());
  handle('home:tour:state', () => companion.tourState());
  handle('home:tour:start', () => { companion.startTour('home'); return companion.tourState(); });
  handle('home:tour:skip', () => { api.setPreference('tour_done', true); return companion.tourState(); });
  handle('home:sessions', () => api.listCompanionSessions());
  handle('home:messages', id => api.listCompanionMessages(Number(id)));
  handle('home:search', q => api.searchCompanionMessages(String(q || '').trim().slice(0,500)));
  handle('home:session:export', async id => {
    const session = api.listCompanionSessions().find(s => s.id === Number(id));
    if (!session) throw new Error('Session not found.');
    const picked = await dialog.showOpenDialog(home, { properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const root = fs.realpathSync(picked.filePaths[0]);
    const file = path.resolve(root, 'nus-session-' + session.id + '-' + Date.now() + '.md');
    if (!inside(root, file) || path.dirname(file) !== root) throw new Error('Export is outside the chosen folder.');
    const text = '# ' + (session.title || 'Nūs Companion session') + '\n\n' + session.started_at + '\n\n' + api.listCompanionMessages(session.id).map(m => '**' + m.channel + '** (' + m.ts + ')\n\n' + m.text).join('\n\n');
    fs.writeFileSync(file, text + '\n', { encoding: 'utf8', flag: 'wx' });
    return { ok: true, path: file };
  });
  handle('home:keeps:list', () => companion.keeps());
  handle('home:keeps:forget', key => { companion.forgetKeep(String(key)); return companion.keeps(); });
  handle('home:tasks:delete', () => companion.deleteTaskData());
  // What Nūs knows about the person: list, add, drop, paste-import (src/memory.js).
  handle('home:memory:panel', () => companion.memoryPanel());
  handle('home:memory:add', (key, value) => { companion.memoryAdd(String(key || 'note').slice(0, 40), String(value || '').slice(0, 500)); return companion.memoryPanel(); });
  handle('home:memory:remove', id => { companion.memoryRemove(String(id || '')); return companion.memoryPanel(); });
  handle('home:memory:import', (source, text) => { if (!['chatgpt', 'claude', 'gemini', 'ai'].includes(source)) throw new Error('Unknown source.'); companion.memoryImport(source, String(text || '').slice(0, 40000)); return companion.memoryPanel(); });
  handle('home:memory:forget-source', source => { companion.memoryForgetSource(String(source || '')); return companion.memoryPanel(); });
  handle('home:memory:prompt', () => companion.memoryPrompt());
  // Layer 1 memory (companion/src/recall): the notes folder, imported AI chats,
  // and forgetting them. Files are only ever picked by the person here.
  handle('home:recall:panel', () => companion.recallPanel());
  handle('home:recall:vault', async () => { const picked = await dialog.showOpenDialog(home, { title: 'Choose your notes folder', properties: ['openDirectory'] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : companion.recallSetVault(fs.realpathSync(picked.filePaths[0])); });
  handle('home:recall:vault-clear', () => companion.recallSetVault(''));
  handle('home:recall:import-folder', () => companion.recallImportFolder());
  handle('home:recall:import-file', async () => { const picked = await dialog.showOpenDialog(home, { title: 'Import an export (ChatGPT, Claude, Google Takeout, Apple Notes)', properties: ['openFile'], filters: [{ name: 'Export', extensions: ['zip', 'json', 'md'] }] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : companion.recallImportFile(picked.filePaths[0]); });
  handle('home:recall:topics', () => companion.recallTopics());
  handle('home:recall:watch', on => companion.recallSetWatch({ watchImports: Boolean(on) }));
  handle('home:recall:watch-folder', async clear => { if (clear) return companion.recallSetWatch({ watchFolder: '' }); const picked = await dialog.showOpenDialog(home, { title: 'Also watch this folder for exports', properties: ['openDirectory'] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : companion.recallSetWatch({ watchFolder: fs.realpathSync(picked.filePaths[0]) }); });
  handle('home:recall:forget', () => companion.recallForgetChats());
  // The Knot's own voice: where it stands, and the one-time model download.
  handle('home:voice:status', () => companion.voiceStatus());
  handle('home:voice:install', name => companion.voiceInstall(String(name || 'fable')));
  // Activity: the last 50 model requests from the usage ledger, in plain words.
  handle('home:activity', () => companion.activity());
  // Reminders and timers set by voice ("remind me at 4 to ..."): list and remove.
  handle('home:reminders:list', () => companion.reminders());
  handle('home:reminders:remove', id => companion.reminderRemove(String(id || '')));
  handle('home:routines:list', () => routines.load(routinesFile));
  handle('home:routines:delete', savedAt => {
    const rows = routines.load(routinesFile).filter(r => r.savedAt !== savedAt);
    fs.writeFileSync(routinesFile + '.tmp', JSON.stringify({ routines: rows }, null, 2));
    fs.renameSync(routinesFile + '.tmp', routinesFile); return rows;
  });
  handle('home:notes:list', notes);
  handle('home:folders:list', () => folders.list().map(f => ({ ...f, topFiles: folders.files(f.id) })));
  handle('home:folders:add', async () => { const picked = await dialog.showOpenDialog(home, { properties: ['openDirectory'] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : folders.add(picked.filePaths[0]); });
  handle('home:folders:remove', id => folders.remove(String(id)));
  handle('home:folders:toggle', (id, enabled) => folders.toggle(String(id), enabled));
  handle('home:folders:reindex', id => folders.reindex(String(id)));
  handle('home:intents', () => INTENTS);
  handle('home:ptt:set', value => { const r = companion.setPttShortcut(value); scheduleSync(); return r; });
  handle('home:open-external', url => { if (!ALLOWED_EXTERNAL.has(url) && !/^https:\/\/github\.com\/potlakai\/nus-desktop\/releases(\/|$)/.test(String(url))) throw new Error('Link is not allowed.'); return shell.openExternal(url); });
  // The newer-version card: check now, or hide it for this version.
  handle('home:update:check', () => getUpdateCheck().check(true));
  handle('home:update:dismiss', () => getUpdateCheck().dismiss());
  handle('home:update:run', () => { getOneClick().run(); return updateState(); });
  handle('home:map:get', () => { const p = api.getPreferences(); return { layout: p.companion_map_layout || {}, viewport: p.companion_map_viewport || null }; });
  handle('home:map:set', (key, value) => {
    if (!['companion_map_layout','companion_map_viewport'].includes(key) || !value || typeof value !== 'object' || JSON.stringify(value).length > 150000) throw new Error('Invalid map preference.');
    const finite = v => Number.isFinite(v) && Math.abs(v) <= 100000;
    if (key.endsWith('viewport') ? !(finite(value.offsetX) && finite(value.offsetY) && value.scale >= .2 && value.scale <= 2) : !Object.values(value).every(p => p && finite(p.x) && finite(p.y))) throw new Error('Invalid map coordinates.');
    api.setPreference(key, value); return { ok: true };
  });
  handle('home:control', action => {
    const actions = { show: () => companion.show(), hide: () => companion.hide(), tutorial: () => companion.startTour() };
    // "Move the Knot to" a corner: it travels there and remembers the spot.
    for (const corner of ['tl', 'tr', 'bl', 'br']) actions['move-' + corner] = () => { companion.moveKnot({ corner }); return companion.status(); };
    if (!actions[action]) throw new Error('Unknown control.'); return actions[action]();
  });
}
const guardQuit = createQuitGuard({ flush: () => databaseReady ? api.flushPersist() : { ok: true },
  ask: async outcome => { const result = await dialog.showMessageBox({ type: 'warning', title: 'Nūs Companion could not save', message: 'Your latest changes have not been saved.', detail: outcome.message || 'Keep the app open and check available disk space.', buttons: ['Keep open','Quit without saving'], defaultId: 0, cancelId: 0 }); return result.response === 1 ? 'quit_without_saving' : 'stay'; },
  retryQuit: () => setImmediate(() => app.quit()) });
// Proctored exams: say it once, then close. The box is not waited on because
// a lockdown browser can cover it; the quit happens either way.
function standDown(name) {
  console.log('[nus-companion] ' + name + ' is open, standing down');
  try { companion?.hide(); companion?.unregisterShortcuts(); } catch {}
  dialog.showMessageBox({ type: 'info', buttons: ['OK'], ...EXAM_MESSAGE }).then(() => app.quit(), () => app.quit());
  setTimeout(() => app.quit(), 8000);
}
const examGuard = createExamGuard({ onExam: standDown });
app.on('before-quit', event => { if (companion?.isCapturing()) companion.setCapturing(false); guardQuit(event); });
// will-quit: the session's minutes go out before the process ends. stats.stop()
// resolves within about a second whatever the network does; the quit is held
// once, for that long at most, then the process exits. A second app.quit()
// after a prevented will-quit is ignored by Electron and left the process
// running; before-quit and will-quit have both run by then, so exit is safe.
let quitFlushed = false;
app.on('will-quit', event => {
  companion?.unregisterShortcuts();
  if (quitFlushed) return;
  quitFlushed = true;
  event.preventDefault();
  stats.stop().catch(() => {}).finally(() => app.exit(0));
});
app.on('window-all-closed', () => {});
app.on('activate', () => { if (databaseReady) openHome(); });
app.whenReady().then(async () => {
  const exam = await examGuard.check();
  if (exam) { standDown(exam); return; }
  examGuard.watch();
  const database = await open(path.join(userData, 'data'));
  databaseReady = true;
  secrets.init(userData); sttLocal.init({ userData });
  folders = createFolders({ api, database, userData, onProgress: value => send('home:indexing', value) });
  companion = companionApp.initCompanion({ standalone: true, desktopComplete: (p,o) => ai.complete(p,o), desktopWarm: o => ai.warm(o),
    audioRoot: () => path.join(userData,'companion','audio'), showDesktop: openHome,
    showFeedback: () => { const w = openHome(); const go = () => send('home:view', { view: 'feedback' }); if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go(); },
    showMyNus: () => { const w = openHome(); const go = () => send('home:view', { view: 'mynus' }); if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go(); },
    showSettings: section => { const w = openHome(); const go = () => send('home:view', { view: 'settings', section: String(section || '') }); if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go(); },
    onCapturePolicy: () => { /* the dashboard stays visible to shares; the Knot alone follows the switch */ },
    onVoiceState: s => send('home:voice', s),
    onReminders: rows => send('home:reminders', rows),
    onRecall: panel => send('home:recall', panel),
    onStateChange: s => send('home:state',s), getDesktopState: lifestyleSnapshot, folderContext: q => folders.context(q),
    // The dashboard's live view: a setting changed anywhere, a task moved, the pill's word.
    onSettingsChanged: () => { send('home:settings', publicSettings()); scheduleSync(); },
    onTaskEvent: p => send('home:tasks', p),
    onKnotWord: w => send('home:knot', w),
    onAsk: ({ mode, feature, outcome }) => {
      stats.ask(mode, feature, outcome);
    },
    // Contract amendment 2026-11-06 (e): a task that really worked, and a day
    // the person actually used Nus (not just left it running).
    onWin: feature => stats.win(feature),
    onEngaged: () => stats.engaged(),
    onAiReady: p => stats.aiReady(p),
    onHookShown: h => stats.hookShown(h),
    onHookUsed: h => stats.hookUsed(h),
    nudgeGroup: () => stats.nudgeGroup(),
    autostart: { enabled: () => store.getSettings().startWithWindows === true, set: on => settingsPatch({ startWithWindows: !!on }) },
    // The tour (companion/src/tour.js): its preferences, its state for Home, and
    // the Home window's own Settings button for the guide demo with no AI set up.
    tourPrefs: { get: () => api.getPreferences(), set: (k, v) => api.setPreference(k, v) },
    onTourState: s => send('home:tour', s),
    tourHomeTarget: async () => {
      const w = openHome();
      if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
      await new Promise(r => setTimeout(r, 400));
      const r = await w.webContents.executeJavaScript('(() => { const q = s => { const b = document.querySelector(s); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; return { button: q("nav button[data-view=\\"settings\\"]"), rail: q("aside.rail") }; })()', true);
      if (!r || !r.button) return null;
      const cb = w.getContentBounds(), off = o => ({ x: cb.x + o.x, y: cb.y + o.y, w: o.w, h: o.h });
      return { button: off(r.button), rail: off(r.rail || r.button) };
    },
    // Card 7: who answers, as this process knows it (Claude Code on the path,
    // or a saved key that createLLM accepts), and the same one-word key check
    // the dashboard's Keys card runs.
    tourAi: async () => ({ cli: !!(await ai.status()).cli, key: createLLM(store.getSettings()).ready }),
    tourTestKey: which => testKeys(String(which || '')),
    tourSaveKey: (kind, key) => settingsPatch({ apiKeys: { [kind]: String(key || '') } }),
    // Card 10: the dashboard on the far side of the screen from the Knot, and
    // where its rail buttons are, in screen pixels, so the Knot can point.
    tourDashboard: async ({ side, narrow, views } = {}) => {
      const w = openHome();
      const area = screen.getDisplayMatching(w.getBounds()).workArea;
      const width = narrow ? 800 : Math.max(800, Math.min(1100, area.width - 520)), height = Math.max(560, Math.min(720, area.height - 80));
      const x = side === 'right' ? area.x + area.width - width - 24 : area.x + 24, y = area.y + Math.max(0, Math.round((area.height - height) / 2));
      w.setBounds({ x, y, width, height });
      if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
      await new Promise(r => setTimeout(r, 450));
      const names = Array.isArray(views) && views.length ? views : ['saved', 'map', 'folders', 'settings'];
      const r = await w.webContents.executeJavaScript('(' + ((list) => { const q = (s) => { const b = document.querySelector(s); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; const out = {}; for (const v of list) out[v] = q('nav button[data-view="' + v + '"]'); return { targets: out, rail: q('aside.rail') }; }).toString() + ')(' + JSON.stringify(names) + ')', true);
      if (!r || !r.targets) return null;
      const cb = w.getContentBounds(), off = o => (o ? { x: cb.x + o.x, y: cb.y + o.y, w: o.w, h: o.h } : null);
      const targets = {}; for (const [k, v] of Object.entries(r.targets)) if (v) targets[k] = off(v);
      return { targets, rail: off(r.rail) };
    },
    onFeature: feature => stats.featureSession(feature),
    onStep: (step, extra) => stats.onboardingStep(step, extra),
    // A voice capture ended: its length in seconds, as feature_session voice.
    onCaptureEnd: meta => stats.featureSession('voice', (Number(meta && meta.duration_ms) || 0) / 1000),
    feedback,
    // The Knot's half of the channel: what to say, and what its fixed buttons do.
    channel: {
      next: enabled => (tourMod.shouldShow(api.getPreferences()) ? null : getChannel().next(enabled)),
      said: item => { getChannel().said(item); if (item.kind === 'update') stats.updateOffered('bubble', item.version); else stats.noticeShown(item.id); },
      canUpdate: () => getOneClick().available(),
      update: () => getOneClick().run(),
      openPage: () => { const u = getChannel().update(); const url = safeLink(u && u.url) || 'https://github.com/potlakai/nus-desktop/releases'; shell.openExternal(url).catch(() => {}); },
      openNotice: item => { const url = safeLink(item && item.link); if (!url) return; stats.noticeClicked(item.id); shell.openExternal(url).catch(() => {}); },
    },
    onSessionStart: meta => store.getSettings().persistTranscripts === false ? null : api.addCompanionSession(meta),
    onSessionEnd: (id,meta) => { const first = api.listCompanionMessages(id)[0]; api.updateCompanionSession(id, { ended_at: meta.ended_at, audio_path: meta.audio_path || '', title: first ? first.text.slice(0,80) : 'Silent session' }); api.flushPersist(); send('home:state', companion.status()); },
    onMessage: (id,turn) => { if (store.getSettings().persistTranscripts !== false) api.addCompanionMessage(id,turn); send('home:state',companion.status()); } });
  adoptLegacyAnthropicKey();
  countAccountOpen();
  registerHomeIpc();
  // The daily version check: at start and every six hours after (the check
  // itself only asks GitHub once a day); never in smoke runs.
  if (!process.argv.includes('--smoke')) {
    // A minute in: the installer that restarted us may still be closing.
    setTimeout(() => getOneClick().cleanup(), 60000).unref();
    setTimeout(() => channelCheck().catch(() => {}), 15000);
    setInterval(() => channelCheck().catch(() => {}), 6 * 3600000).unref();
    // The Knot looks for a quiet moment every five minutes, from two minutes in.
    setTimeout(() => { companion.channelTick(); setInterval(() => companion.channelTick(), 5 * 60000).unref(); }, 120000).unref();
  }
  setSaveStateListener(s => send('home:save-state', s));
  // The first launch opens Home, and so does every launch until Get started is
  // done or skipped.
  // Started by Windows at sign-in: quietly, just the Knot, unless the tour is still owed.
  const atLogin = process.argv.includes('--autostart');
  if ((!atLogin && !api.getPreferences().home_seen) || tourMod.shouldShow(api.getPreferences()) || SMOKE) openHome();
  // A chosen start-with-Windows is written again at each start, so it stays as
  // set and follows the exe if an update moved it (Clicky 1.0.50 had to fix exactly this).
  if (!SMOKE && typeof store.getSettings().startWithWindows === 'boolean') applyAutostart(store.getSettings().startWithWindows);
  // install on the first run ever, app_open now and once a day from the tray.
  // Never awaited: a slow or missing network must not hold the Knot up.
  // Windows ties notifications to this id (the build's appId).
  if (process.platform === 'win32') { try { app.setAppUserModelId('com.nus.companion'); } catch (_) { /* notifications only */ } }
  // --autostart is the argument Windows passes when it starts Nus at sign-in.
  if (!SMOKE) stats.boot({ via: process.argv.includes('--autostart') ? 'login' : 'manual' });
  // A signed-in computer whose link missed (offline at sign-in, or stats
  // turned back on) tries again once, 20 s in. Signed out: nothing at all.
  if (!SMOKE && getAccount().status().signedIn) setTimeout(() => getLink().ensure().then(() => getEntitlement().refresh()).then(() => send('home:account', accountState())).catch(() => {}), 20000).unref();
  // Sync (when ticked) and the plan: 30 s in, then every six hours; sync also
  // 5 s after a change.
  if (!SMOKE) {
    const syncTick = () => {
      if (!getAccount().status().signedIn) return;
      Promise.resolve(getSync().status().syncOn ? getSync().sync() : null).then(() => getEntitlement().refresh()).then(() => send('home:account', accountState())).catch(() => {});
    };
    setTimeout(syncTick, 30000).unref(); setInterval(syncTick, 6 * 3600000).unref();
  }
  // Notes left waiting (offline, or the server not answering yet) go a
  // minute after start and every half hour after.
  if (!SMOKE) { setTimeout(() => feedback.flush().catch(() => {}), 60000); setInterval(() => feedback.flush().catch(() => {}), 30 * 60000).unref(); }
  if (SMOKE && process.env.NUS_HANDS_SMOKE) {
    // Hands smoke: the agent builds and one screen read comes back. It never acts.
    setTimeout(() => companion.handsCheck().then(r => console.log('[nus-companion] hands smoke ' + JSON.stringify(r))).catch(e => console.log('[nus-companion] hands smoke FAILED: ' + e.message)).finally(() => app.quit()), Number(process.env.NUS_HANDS_SMOKE_MS) || 5000);
  } else if (SMOKE) { console.log('[nus-companion] smoke ok: overlay up, home up'); setTimeout(() => app.quit(),1600); }
}).catch(error => { console.error('[nus-companion] startup failed:',error.message); app.exit(1); });
