'use strict';
// The first-run tour: eleven cards on the Knot's own sheet over the person's
// real screen (renders-0115-2026-11-02, O1 direction B; reworked after
// Pranav's live test of 2026-11-02, docs/tour-0115.md). The Knot's voice
// first, then the mic check, the talk key taught by doing, three spoken
// questions, where the Knot lives, screen sharing, who answers, a guide demo,
// a Hands demo behind a consent card, the dashboard, done. Cards 2 to 4 need
// only the local whisper and the rules. The demos have a path with no AI set
// up, on the dashboard's own controls, and the card says so. English only,
// pinned: the card copy never follows a guess.
//
// Pure Node, no Electron: main (companion/index.js) runs the steps and owns
// the preferences; this file holds the words and the small rules.

// The 0.1.15 order. The capabilities-first order waits for the reworked tour
// in a later release (its card 5 could not be passed with Claude Code signed out).
const STEP = { voice: 1, mic: 2, key: 3, questions: 4, home: 5, sharing: 6, ai: 7, guide: 8, hands: 9, dashboard: 10, done: 11 };
const OF = 11;
const { geminiKeyShape } = require('./get-started');
const QUESTIONS = [
  { q: 'What are you working on these days?', ack: 'Got it.', note: 'working on' },
  { q: 'What would you like to get done this week?', ack: 'Noted.', note: 'this week' },
  { q: 'Have you used an AI helper before?', ack: 'Good to know.', note: 'used AI before' },
];
const HANDS_LINES = ['Hold Ctrl and Alt to talk to the Knot', 'Ask it about anything on your screen', 'Say yes when it asks first'];
const TRY_CHIPS = ['What does this page say?', 'Where is the export button?', 'Tidy my Downloads'];
// The last card's first win (plan 2026-11-06): the person taps what gets them
// stuck and the Knot does it now, for real. Each one names a struggle (the
// stats list in companion/src/stats.js). The ones marked ai need an answer
// source; with none, only the ones that work offline are offered, so the
// first try always works.
const FIRST_WINS = [
  { struggle: 'feeds', label: 'Keep me off Reels', ai: false },
  { struggle: 'homework_start', label: 'Help me start my homework', ai: false },
  { struggle: 'find_in_apps', label: 'Show me this screen', ai: true },
  { struggle: 'remember', label: 'Remember something for me', ai: false },
];
function firstWins(caps = {}) {
  const ai = !!(caps.keyReady || caps.cli);
  return FIRST_WINS.filter((w) => ai || !w.ai).slice(0, 3);
}
const GUIDE_DEMO_LINE = 'This is Settings. Keys, your voice and Hands live here.';
// Card 8's suggested question fits the window in front (live 2026-11-03: "Where
// do I attach a file?" with OBS in front, and the model talked about a chat tool).
const BROWSERS = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|arc|iexplore)$/i;
const MAIL_APPS = /^(?:outlook|olk|hxoutlook|thunderbird)$/i;
const MAIL_TITLE = /\b(?:gmail|outlook|inbox|compose mail|mail)\b/i;
const GUIDE_CHIP_ANY = 'What is this window for?';
function guideChip(front) {
  const proc = String((front && front.process) || '').replace(/\.exe$/i, '').trim();
  const title = String((front && front.title) || '');
  if (MAIL_APPS.test(proc) || (BROWSERS.test(proc) && MAIL_TITLE.test(title))) return 'Where do I attach a file?';
  if (BROWSERS.test(proc)) return 'Where is the address bar?';
  if (/^winword$/i.test(proc)) return 'Where do I change the font?';
  if (/^notepad$/i.test(proc)) return 'Where do I save this?';
  if (/^systemsettings$/i.test(proc) || (/^applicationframehost$/i.test(proc) && /\bsettings\b/i.test(title))) return 'Where do I turn on dark mode?';
  return GUIDE_CHIP_ANY;
}
const HANDS_CARD = { title: 'Open Notepad and type a list?', hint: 'It runs on this PC with no AI model. Nothing is sent anywhere.' };
const HANDS_DONE_LINE = 'That was me on your mouse. Ask me to do something in any app and I will.';
// The action could not see the words land: the card says so, never "that was me".
const HANDS_UNSURE_LINE = 'I typed that, but I could not see it land. Have a look at Notepad.';
const NOT_ENGLISH_LINE = 'Nūs speaks English for now.';
// The voice download: the model is about 350 MB (companion/src/voice/index.js).
const VOICE_MB = 350;
const VOICE_LANDED_LINE = 'That is me now.';
const VOICE_FAILED_LINE = 'My voice did not download. The Windows voice stays for now. You can try again on the dashboard, under Settings, Voice.';
// Card 10: the Knot's loose end walks the dashboard's rail, one line a stop.
const DASHBOARD_STOPS = [
  { view: 'mynus', line: 'My Nūs: your week, what I did for you, and everything I know about you.' },
  { view: 'saved', line: 'Saved: what I keep for you, and what I did today.' },
  { view: 'map', line: 'Map: your notes and chats, laid out as a map.' },
  // Folders reads files so answers can use them; it never moves or tidies them.
  { view: 'folders', line: 'Folders: the folders I read, so I can answer from your own files.' },
  { view: 'settings', line: 'Settings: keys, my voice, where I live, and screen sharing.' },
];
const DASHBOARD_DONE_LINE = 'That is the dashboard. The tray icon opens it any time.';
const DASHBOARD_TUCK = 'This is the dashboard.';
const DASHBOARD_FAILED_LINE = 'I could not open the dashboard here. The tray icon opens it any time.';
const HOME_CHANGED_LINE = 'You can change this later from the tray or on the dashboard.';
const KEY_OK_LINE = 'The key works. I can answer and point now.';
const KEY_BAD_LINE = 'That does not look like a Gemini or Anthropic key. Copy it again and paste the whole key.';
const KEY_FAILED_LINE = 'That key did not answer. Check it and try again, or come back to it on the dashboard.';

// Who sees it: an install whose first dashboard window opened on a build with
// the tour. An upgrade has home_seen already and never sees it. Done or
// skipped once, it stays gone; Quick tour starts it again any time.
function shouldShow(prefs) { const p = prefs || {}; return p.tour_pending === true && p.tour_done !== true; }
function onFirstWindow(prefs) { const p = prefs || {}; return p.home_seen ? {} : { tour_pending: true }; }

// The system locale is read once and never guessed from what was heard.
function englishLocale(locale) { return /^en(?:[-_]|$)/i.test(String(locale || '')); }

// "my name is Maya" -> "Maya". Anything short with no pattern is taken as the
// name, because that is what the card asked for; a sentence is not.
function nameFrom(text) {
  let t = String(text || '').trim().replace(/[.!?,;:]+$/g, '').trim();
  const m = t.match(/\b(?:my name is|my name's|i am|i'm|im|it's|its|this is|call me|name is|name's)\s+(.+)$/i);
  if (m) t = m[1].trim();
  t = t.replace(/^(?:called|named)\s+/i, '').replace(/[.!?,;:]+$/g, '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > (m ? 3 : 2)) return '';
  if (words.some((w) => w.length > 20 || !/^[\p{L}][\p{L}'’-]*$/u.test(w))) return '';
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// A pasted key, by its shape: Anthropic keys start with sk-ant-, Gemini keys
// go through the dashboard's own check (companion/src/get-started.js). Anything
// else is not saved. -> { kind, key, message }, kind '' when it is not a key.
function keyCheck(text) {
  const t = String(text || '').trim().replace(/^["']|["']$/g, '');
  if (/^sk-ant-/i.test(t)) return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(t) ? { kind: 'anthropic', key: t, message: '' } : { kind: '', key: t, message: 'That key looks cut off. Copy the whole key again.' };
  const shape = geminiKeyShape(t);
  if (shape.ok) return { kind: 'gemini', key: shape.key, message: '' };
  return { kind: '', key: t, message: /cut off/.test(shape.message) ? shape.message : KEY_BAD_LINE };
}

// 'Control+Alt' -> ['Ctrl', 'Alt']
function keycaps(accelerator) {
  return String(accelerator || 'Control+Alt').split('+').map((k) => k.trim()).filter(Boolean).map((k) => (/^(commandorcontrol|control|ctrl)$/i.test(k) ? 'Ctrl' : /^return$/i.test(k) ? 'Enter' : k));
}
const continueActions = (disabled) => [{ id: 'tour-next', label: 'Continue', primary: true, disabled: !!disabled }];
function qaRows(qa, current) { return (qa || []).map((row, i) => ({ q: row.q, a: row.a || '', current: i === current })); }
// The two homes on card 5, the one in use marked.
function homeChoices(island) {
  return [{ id: 'tour-home-free', label: 'Free Knot', pic: 'free', on: !island }, { id: 'tour-home-island', label: 'Island bar', pic: 'island', on: !!island }];
}
// The switch on card 6.
function sharingToggle(caps) { return { id: 'tour-sharing', label: 'Hide me from screen sharing', on: !!caps.hideFromCapture, disabled: !!caps.captureForcedOff }; }
// The voice download, as a thin line under the dots on every card while it runs.
function progressOf(voice) {
  const d = voice && voice.downloading;
  if (!d) return null;
  const pct = d.total ? Math.max(0, Math.min(100, Math.round(d.got / d.total * 100))) : 0;
  // All in, it still has to be checked and unpacked, which takes a while.
  return { pct, label: pct >= 100 ? 'Fable: unpacking' : 'Fable ' + pct + '%' };
}

// Everything the sheet shows for one step. info: { name, caps: { whisper,
// source, cli, keyReady, hands, english, ptt, device, island, hideFromCapture,
// captureForcedOff, voice: { installed, downloading }, desktopApp }, qa }.
function card(step, info = {}) {
  const caps = info.caps || {}, name = String(info.name || '').trim(), voice = caps.voice || {};
  const base = { step, of: OF, skip: step < OF, note: '', progress: progressOf(voice) };
  if (step === STEP.voice) {
    if (voice.installed) return Object.assign(base, { kind: 'voice', title: 'This is my voice', body: 'This is Fable, my own voice. It runs on this PC and works offline.', spoken: 'Hi. This is my voice. It runs right here on your computer.', status: '', actions: continueActions(false) });
    if (voice.downloading) return Object.assign(base, { kind: 'voice', title: 'This is my voice, for now', body: 'Fable, my own voice, is on its way. The Windows voice stands in until it lands, then I switch.', spoken: 'My own voice is on its way. The Windows voice stands in until then.', status: '', actions: continueActions(false) });
    return Object.assign(base, { kind: 'voice', title: 'This is my voice, for now', body: 'That was the Windows voice standing in. Mine is called Fable: a ' + VOICE_MB + ' MB download that runs on this PC and never goes online after. It keeps downloading while we go on.', spoken: 'Hi. The Windows voice is standing in for me. Want my own? It is one download.',
      note: 'You can get it later on the dashboard, under Settings, Voice.', status: '', actions: [{ id: 'tour-voice-get', label: 'Download Fable', primary: true }, { id: 'tour-next', label: 'Later' }] });
  }
  if (step === STEP.mic) return Object.assign(base, { kind: 'mic', title: 'Now, can I hear you?', body: 'Say anything out loud. If the bars move, your mic works.', spoken: 'Now, can I hear you? Say anything.', note: caps.english === false ? NOT_ENGLISH_LINE : '', device: caps.device || '', status: '', actions: continueActions(true) });
  if (step === STEP.key) {
    const typed = caps.whisper === false;
    return Object.assign(base, { kind: 'key', title: 'This is how you talk to me', keys: keycaps(caps.ptt),
      body: typed ? 'I cannot hear words on this computer yet, so type your name instead.' : 'Hold the keys, say your name, let go. I listen the whole time you hold them.',
      spoken: typed ? 'Type your name and I will remember it.' : 'Hold the keys, say your name, and let go.',
      chip: typed ? '' : 'My name is ...', status: typed ? '' : 'Waiting for you',
      input: typed ? { action: 'tour-name', placeholder: 'Your name', label: 'Continue' } : null, actions: continueActions(true) });
  }
  if (step === STEP.questions) {
    const typed = caps.whisper === false;
    return Object.assign(base, { kind: 'questions', title: 'Three quick questions', body: typed ? 'So what comes next is about you. Type to answer.' : 'So what comes next is about you. Hold the keys to answer.', spoken: 'Three quick questions.',
      qa: qaRows(info.qa || QUESTIONS.map((q) => ({ q: q.q, a: '' })), 0), status: typed ? 'Type your answer.' : 'Hold the keys to answer.',
      input: { action: 'tour-answer', placeholder: typed ? 'Your answer' : 'Or type your answer', label: 'Send' },
      actions: [{ id: 'tour-skip-questions', label: 'Skip these' }].concat(continueActions(true)) });
  }
  if (step === STEP.home) return Object.assign(base, { kind: 'home', title: 'Where should I live?', body: 'Free, I sit where you put me and you can drag me anywhere. In the island bar I dock at the top of the screen and my words run along it. Tap one and watch.', spoken: 'Where should I live? Tap one and watch me move.', choices: homeChoices(caps.island), status: '', actions: continueActions(false) });
  if (step === STEP.sharing) return Object.assign(base, { kind: 'sharing', title: 'On a call or a recording', body: 'Off, people on your call see me too. On, I am invisible in screen shares and recordings, so only you see me.', spoken: 'On a call, I can stay out of the picture. Your choice.', toggle: sharingToggle(caps), note: caps.captureForcedOff ? 'Turned off for this session by its settings.' : '', status: '', actions: continueActions(false) });
  if (step === STEP.ai) {
    if (caps.cli) return Object.assign(base, { kind: 'ai', title: 'Who answers', body: 'Claude Code is installed on this computer. If it is signed in, I use it to answer and to point, with no key at all.', spoken: 'Claude Code is here, so I can answer with no key.', note: 'A Gemini or Anthropic key can go on the dashboard, under Settings, Keys.', status: '', actions: continueActions(false) });
    if (caps.keyReady) return Object.assign(base, { kind: 'ai', title: 'Who answers', body: 'An AI key is saved already. I use it to answer and to point.', spoken: 'Your AI key is saved. I can answer and point.', note: 'Keys live on the dashboard, under Settings, Keys.', status: '', actions: continueActions(false) });
    return Object.assign(base, { kind: 'ai', title: 'Who answers', body: 'Paste a free Gemini key, or an Anthropic key. It stays on this device, encrypted. You can add or change it any time on the dashboard, under Settings, Keys.', spoken: 'Who answers your questions? Paste a key here, or later on the dashboard.',
      input: { action: 'tour-key', placeholder: 'Gemini or Anthropic key', label: 'Save', secret: true }, status: '', actions: [{ id: 'tour-next', label: 'Later' }] });
  }
  if (step === STEP.guide) {
    if (caps.source) return Object.assign(base, { kind: 'guide', title: 'I see what you see', body: 'Hold the keys and ask me about the window behind this card.', spoken: 'Hold the keys and ask me about the window behind this card.', keys: keycaps(caps.ptt), chip: GUIDE_CHIP_ANY, status: '', actions: continueActions(true) });
    return Object.assign(base, { kind: 'guide', title: 'I see what you see', body: 'No AI is set up yet, so I will show you on the dashboard.', spoken: 'No AI is set up yet, so I will show you on the dashboard.', status: '', actions: [{ id: 'tour-show', label: 'Show me', primary: true }] });
  }
  if (step === STEP.hands) {
    if (caps.hands) return Object.assign(base, { kind: 'hands', title: 'I can use the mouse too', body: 'Say yes on the card and I will open Notepad and type a short list while you watch. Press Esc to stop me at any time.', spoken: 'I can use the mouse too. Say yes on the card and watch.', status: '', actions: [] });
    return Object.assign(base, { kind: 'hands', title: 'I can use the mouse too', body: 'Hands is not available on this computer yet.', spoken: 'Hands is not available on this computer yet.', status: '', actions: continueActions(false) });
  }
  if (step === STEP.dashboard) return Object.assign(base, { kind: 'dashboard', title: 'The dashboard', body: 'Everything I keep and every setting lives on the dashboard. Here it is, beside this card.', spoken: 'Last thing: the dashboard, where everything lives.', status: '', actions: continueActions(true) });
  const title = name ? "That's it, " + name + '.' : "That's it.";
  // Inside the desktop app the Knot's tour hands over to the desktop's own tour.
  const tries = firstWins(caps).map((w, i) => ({ id: 'tour-try-' + w.struggle, label: w.label, primary: i === 0 }));
  const actions = (caps.desktopApp ? [{ id: 'tour-desktop', label: 'Tour the desktop app' }] : []).concat(tries, [{ id: 'tour-finish', label: 'Just explore' }]);
  return Object.assign(base, { kind: 'done', title, body: 'Hold these keys any time, in any app, and ask. Or pick one and I will do it right now.', spoken: title + ' Hold these keys any time and ask. Or pick one, and I will do it now.', keys: keycaps(caps.ptt), status: '', actions });
}

// The one line the tuck shows while a demo has the screen.
function tuckLine(step, text) { return 'Step ' + step + ' of ' + OF + '. ' + text; }

// Every spoken line of a whole run, for the length check and for warming the
// Knot's line cache so each card's line starts as the card does.
function spokenLines(caps) {
  const out = [];
  for (let s = 1; s <= OF; s++) out.push(card(s, { caps, name: 'Maya' }).spoken);
  out.push('Loud and clear.', 'Hi, Maya. That key works anywhere.');
  for (const q of QUESTIONS) out.push(q.q, q.ack);
  out.push('Thank you.', HOME_CHANGED_LINE, GUIDE_DEMO_LINE, HANDS_DONE_LINE, HANDS_UNSURE_LINE, 'Another time.', VOICE_LANDED_LINE, KEY_OK_LINE, DASHBOARD_DONE_LINE);
  for (const s of DASHBOARD_STOPS) out.push(s.line);
  return out;
}
// The fixed lines worth keeping as files once made (the name line is not fixed).
function cachedLines() {
  const caps = { whisper: true, source: true, cli: false, keyReady: false, hands: true, english: true, voice: { installed: true } };
  const lines = new Set(spokenLines(caps).filter((l) => !/Maya/.test(l)));
  for (const c of [{ installed: false }, { downloading: { got: 1, total: 2 } }]) lines.add(card(STEP.voice, { caps: Object.assign({}, caps, { voice: c }) }).spoken);
  for (const extra of [{ source: false }, { cli: true }, { keyReady: true }, { hands: false }, { whisper: false }]) for (let s = 1; s <= OF; s++) lines.add(card(s, { caps: Object.assign({}, caps, extra) }).spoken);
  return [...lines].filter(Boolean);
}

module.exports = { STEP, OF, QUESTIONS, HANDS_LINES, TRY_CHIPS, FIRST_WINS, firstWins, GUIDE_DEMO_LINE, guideChip, HANDS_CARD, HANDS_DONE_LINE, HANDS_UNSURE_LINE, NOT_ENGLISH_LINE, VOICE_MB, VOICE_LANDED_LINE, VOICE_FAILED_LINE, DASHBOARD_STOPS, DASHBOARD_DONE_LINE, DASHBOARD_TUCK, DASHBOARD_FAILED_LINE, HOME_CHANGED_LINE, KEY_OK_LINE, KEY_BAD_LINE, KEY_FAILED_LINE,
  shouldShow, onFirstWindow, englishLocale, nameFrom, keyCheck, keycaps, continueActions, qaRows, homeChoices, sharingToggle, progressOf, card, tuckLine, spokenLines, cachedLines };
