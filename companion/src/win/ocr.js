// The words on a screenshot, through the OCR engine built into Windows
// (ocr.ps1). One short-lived PowerShell per read: about a second, local, free.
// Anything that goes wrong is a rejection; assignment mode then lets the model
// decide instead.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'ocr.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const TIMEOUT_MS = 8000;

function ocrFile(file) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('ocr is Windows only')); return; }
    // WinRT's GetFileFromPathAsync refuses forward slashes and relative paths.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', path.resolve(file)],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(String(stderr || err.message).trim().slice(0, 200))); return; }
        resolve(String(stdout || '').replace(/^﻿/, ''));
      });
  });
}

// jpeg: a Buffer. dir: where the short-lived file goes (app-owned).
// probe: the long-lived Windows probe when it is up; its 'ocr' op skips the
// half second a fresh PowerShell costs. A probe failure falls back to one.
async function ocrJpeg(jpeg, dir, probe) {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.jpg');
  await fs.promises.writeFile(file, jpeg);
  try {
    if (probe && probe.available) {
      try {
        const r = await probe.request('ocr', { path: path.resolve(file) }, TIMEOUT_MS);
        if (r && typeof r.text === 'string') return r.text;
        throw new Error((r && r.error) || 'no text from the probe');
      } catch (e) { /* the one-shot path below still works */ void e; }
    }
    return await ocrFile(file);
  } finally { try { await fs.promises.unlink(file); } catch (_) { /* best effort */ } }
}

module.exports = { ocrFile, ocrJpeg };
