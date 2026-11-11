#!/usr/bin/env node
// Fetches the local embedding model the Companion searches by meaning with
// (companion/src/recall/embed.js) into vendor/embed-models, where dev runs and
// electron-builder.companion.config.js (extraResources) find it.
//
// sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0), the int8 ONNX export
// published as Xenova/all-MiniLM-L6-v2. Checked against the hashes below, so a
// changed upstream file is refused rather than shipped.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/';
const FILES = [
  { url: BASE + 'onnx/model_quantized.onnx', name: 'model_quantized.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
  { url: BASE + 'vocab.txt', name: 'vocab.txt', sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
];
const dir = path.join(__dirname, '..', 'vendor', 'embed-models', 'all-MiniLM-L6-v2');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const out = path.join(dir, f.name);
    if (fs.existsSync(out) && sha(fs.readFileSync(out)) === f.sha256) { console.log('ok      ' + f.name); continue; }
    process.stdout.write('fetch   ' + f.name + ' ... ');
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(f.url + ' answered ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== f.sha256) throw new Error(f.name + ' does not match its expected hash; not saved');
    fs.writeFileSync(out, buf);
    console.log((buf.length / 1048576).toFixed(1) + ' MB');
  }
  console.log('Embedding model ready in ' + dir);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
