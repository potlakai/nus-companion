'use strict';
// One whisper.cpp server kept running, so speech is turned into words without
// starting a process and loading the model on every call.
//
// whisper-cli per call costs about 0.43 s for a 3.4 s clip on the Ryzen 7 4700U
// (process start, DLLs, model load, then the decode); the same clip through a
// resident whisper-server takes about 0.17 s (measured 2026-10-19, base.en q5_1,
// 8 threads, -ac sized to the clip, release b4938). The server ships in the
// same whisper.cpp release zip as whisper-cli (npm run setup:voice keeps it).
//
// - Listens on 127.0.0.1 only, on a free port, under a random request path
//   prefix (so /health, /load and the index page are not at their bare routes)
//   and a random inference path under it; another program has to guess all
//   three to use it (security validation 2026-11-01, L5).
// - Starts on warm() or the first transcribe(); until it answers /health the
//   caller gets null and uses whisper-cli, so nothing ever waits on it.
// - Goes away after IDLE_MS without a request (it holds the model in memory)
//   and with the app (process exit). A start that fails is not retried for
//   RETRY_MS; whisper-cli carries on meanwhile.
// - One server per model file, shared by the streaming ears (companion/src/
//   reflex/listen.js) and the plain push-to-talk path (src/stt-local.js).
// - It decodes one request at a time and finishes a decode whose caller hung up
//   (measured 2026-11-03: a 1 s clip took 367 ms alone, 688 ms right after an
//   aborted 9 s one). So a request that timed out leaves it busy for a while:
//   for ABANDON_MS the caller gets null at once rather than queue behind that
//   decode. A final that times out, or two partials in a row, restarts it.
//
// Pure Node; spawn, the HTTP request and the clock are injectable for tests.
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn: nodeSpawn } = require('child_process');

const IDLE_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 10000;
const RETRY_MS = 60000;
const ABANDON_MS = 2500;     // a decode nobody waits for any more: about the longest a decoder loop runs
const SLOW_MS = 700;         // a partial hung up on after this long was no ordinary one (they take 200 to 400 ms)
const PARTIAL_STRIKES = 2;   // partials timing out in a row before the server counts as stalled
const SERVER_NAMES = process.platform === 'win32' ? ['whisper-server.exe', 'server.exe'] : ['whisper-server', 'server'];

// whisper.cpp pads every clip to 30 s of encoder context, which costs about
// 2 s however short the audio is; -ac (audio_ctx) sized to the clip brings a
// 3.4 s clip from 2.05 s to 0.43 s with the same words (measured 2026-10-19).
function audioCtxFor(ms) {
  // 50 encoder frames per second of audio, plus headroom, in steps of 64.
  const need = Math.ceil((ms / 1000) * 50) + 48;
  // Below 256 the decoder falls into repetition loops on clips cut mid-word
  // (measured: -ac 192 looped at 840 ms and 1000 ms cuts, 256 never did).
  return Math.max(256, Math.min(1500, Math.ceil(need / 64) * 64));
}

// The server binary next to a whisper-cli, if the release shipped one.
function serverBeside(cliPath) {
  if (!cliPath) return null;
  for (const name of SERVER_NAMES) {
    const full = path.join(path.dirname(cliPath), name);
    try { if (fs.existsSync(full)) return full; } catch (_) { /* not there */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// multipart/form-data body: text fields, then the WAV as "file".
function formBody(fields, wav) {
  const boundary = '----nus' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(v) + '\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'), wav, Buffer.from('\r\n--' + boundary + '--\r\n'));
  return { boundary, body: Buffer.concat(parts) };
}

// -> { status, text } or throws.
function httpRequest({ port, path: p, method = 'GET', headers = {}, body = null, timeoutMs = 5000, signal = null }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: s }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.end(body || undefined);
  });
}

function createWhisperServer({ exe, model, threads, spawn = nodeSpawn, request = httpRequest, port: pickPort = freePort, log = () => {}, now = () => Date.now(), idleMs = IDLE_MS, startTimeoutMs = START_TIMEOUT_MS, retryMs = RETRY_MS, pollMs = 60, abandonMs = ABANDON_MS, slowMs = SLOW_MS } = {}) {
  const nThreads = String(threads || Math.max(2, Math.min(8, os.cpus().length)));
  let state = exe && model ? 'off' : 'missing';   // off | starting | ready | failed | missing
  let child = null, port = 0, prefix = '', route = '', starting = null, failedAt = 0, idleTimer = null, lastUse = 0;
  let strikes = 0, abandonedAt = null;   // partials timed out in a row; when a decode was last left running

  function stop(why) {
    clearTimeout(idleTimer); idleTimer = null;
    if (child) { try { child.kill(); } catch (_) { /* already gone */ } log('[whisper-server] stopped (' + why + ')'); }
    child = null; starting = null; strikes = 0; abandonedAt = null;
    if (state !== 'missing') state = 'off';
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (now() - lastUse >= idleMs - 5) stop('idle'); else armIdle(); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function start() {
    const t0 = now();
    port = await pickPort();
    // --request-path moves /, /health and /load under the prefix too; the
    // inference route sits under it as prefix + route.
    prefix = '/p' + crypto.randomBytes(12).toString('hex');
    route = '/i' + crypto.randomBytes(12).toString('hex');
    const args = ['-m', model, '-t', nThreads, '-l', 'en', '-nf', '-bo', '1', '-bs', '1', '-nt', '--host', '127.0.0.1', '--port', String(port), '--request-path', prefix, '--inference-path', route];
    const c = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child = c;
    let exited = false;
    c.on('exit', (code) => { exited = true; if (child === c) { child = null; if (state === 'ready') log('[whisper-server] exited (' + code + ')'); if (state !== 'missing') state = 'off'; } });
    c.on('error', (e) => { exited = true; log('[whisper-server] ' + e.message); });
    while (!exited && child === c && now() - t0 < startTimeoutMs) {
      try { const r = await request({ port, path: prefix + '/health', timeoutMs: 1000 }); if (r.status === 200) break; } catch (_) { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (exited || child !== c || now() - t0 >= startTimeoutMs) {
      if (child === c) stop('start failed');
      state = 'failed'; failedAt = now();
      log('[whisper-server] did not start; whisper-cli carries on');
      return false;
    }
    state = 'ready'; lastUse = now(); armIdle();
    log('[whisper-server] ready in ' + (now() - t0) + 'ms on 127.0.0.1');
    return true;
  }

  // Start it if it is not running. Never throws, never waits for the caller.
  function warm() {
    if (state === 'missing' || state === 'ready' || starting) return starting || Promise.resolve(state === 'ready');
    if (state === 'failed' && now() - failedAt < retryMs) return Promise.resolve(false);
    state = 'starting';
    starting = start().catch((e) => { log('[whisper-server] ' + e.message); state = 'failed'; failedAt = now(); return false; }).finally(() => { starting = null; });
    return starting;
  }

  // WAV bytes in -> the words, '' for silence, or null when the server cannot
  // answer right now (the caller then runs whisper-cli). partial: a guess at
  // words still being said, so one that runs late costs a strike, not a restart.
  // signal: the caller no longer wants this one (its final has arrived).
  async function transcribe(wav, { audioCtx, prompt, timeoutMs = 8000, signal = null, partial = false } = {}) {
    if (state !== 'ready') { warm(); return null; }
    if (abandonedAt != null && now() - abandonedAt < abandonMs) return null;
    abandonedAt = null;
    lastUse = now();
    const askedAt = now(), asked = child;
    const { boundary, body } = formBody({ response_format: 'json', language: 'en', temperature_inc: '0', best_of: '1', no_timestamps: 'true', audio_ctx: audioCtx ? String(audioCtx) : '', prompt: prompt || '' }, wav);
    try {
      const r = await request({ port, path: prefix + route, method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }, body, timeoutMs, signal });
      if (r.status !== 200) { log('[whisper-server] HTTP ' + r.status); return null; }
      const j = JSON.parse(r.text);
      strikes = 0;
      if (j && typeof j.text === 'string') return j.text;
      return null;
    } catch (e) {
      // The caller hung up: no fault of the server's, though it is still decoding.
      if (e && e.message === 'aborted') { if (now() - askedAt >= slowMs) abandonedAt = now(); return null; }
      log('[whisper-server] request failed: ' + (e && e.message) + (partial ? ' (partial, ' + timeoutMs + 'ms)' : ''));
      // Refused or reset: the process is gone (unless it was just replaced).
      if (e && /ECONNREFUSED|ECONNRESET|EPIPE/.test(String(e.code || e.message))) { if (child === asked) stop('unreachable'); return null; }
      // A timeout leaves it running, on a decode nobody is waiting for.
      if (e && e.message === 'timeout' && child === asked) {
        abandonedAt = now();
        strikes = partial ? strikes + 1 : PARTIAL_STRIKES;
        if (strikes >= PARTIAL_STRIKES) { stop('stalled'); warm(); }
      }
      return null;
    }
  }

  function status() { return { state, port: state === 'ready' ? port : 0 }; }
  return { warm, transcribe, close: () => stop('closed'), status };
}

// One per model file, closed with the process.
const shared = new Map();
let exitHooked = false;
function sharedWhisperServer({ exe, model, log } = {}) {
  if (!exe || !model) return null;
  const key = exe + '|' + model;
  if (!shared.has(key)) {
    shared.set(key, createWhisperServer({ exe, model, log }));
    if (!exitHooked) { exitHooked = true; process.once('exit', () => { for (const s of shared.values()) s.close(); }); }
  }
  return shared.get(key);
}

module.exports = { createWhisperServer, sharedWhisperServer, serverBeside, formBody, audioCtxFor, httpRequest };
