// Downloads the whisper.cpp Windows binary and the base English model for local voice.
// Usage: npm run setup:voice [-- --small]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WHISPER_TAG = 'b4938';
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`;
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin';
const MODEL_SMALL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin';

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor', 'whisper');
const modelDir = path.join(root, 'vendor', 'whisper-models');

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  saved ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

function findExe(dir) {
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === name) return full;
      }
    }
  }
  return null;
}

// Keep only what the Companion runs: whisper-cli, and whisper-server, which
// keeps the model loaded between asks (src/whisper-server.js). The zip also
// ships benches, tests and demos.
function prune(dir) {
  const keep = /^(whisper-cli\.exe|whisper-server\.exe|main\.exe|.*\.dll)$/i;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else if (!keep.test(entry.name)) fs.rmSync(full, { force: true });
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('setup:voice downloads the Windows whisper.cpp build only; the Mac app ships without local voice for now.');
    console.error('On macOS: brew install whisper-cpp, then start Nus with NUS_WHISPER_DIR=$(brew --prefix)/bin and it finds whisper-cli there.');
    process.exit(1);
  }
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  const zipPath = path.join(vendorDir, 'whisper-bin-x64.zip');
  // A vendor folder from before whisper-server was kept is fetched again.
  if (!findExe(vendorDir) || !fs.existsSync(path.join(vendorDir, 'whisper-server.exe'))) {
    await download(BIN_URL, zipPath);
    // Unpacked beside, then the binaries move up (some release zips nest them
    // in a subfolder), replacing older copies.
    const unpack = path.join(vendorDir, '_unpack');
    fs.rmSync(unpack, { recursive: true, force: true });
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${unpack}" -Force`,
    ], { stdio: 'inherit' });
    fs.unlinkSync(zipPath);
    const found = findExe(unpack);
    if (found) {
      for (const entry of fs.readdirSync(path.dirname(found))) {
        const from = path.join(path.dirname(found), entry);
        if (fs.statSync(from).isFile()) fs.renameSync(from, path.join(vendorDir, entry));
      }
    }
    fs.rmSync(unpack, { recursive: true, force: true });
  }
  prune(vendorDir);
  const exe = findExe(vendorDir);
  if (!exe) throw new Error('whisper binary not found after extract');
  console.log(`Binary ready: ${exe}`);
  if (!fs.existsSync(path.join(vendorDir, 'whisper-server.exe'))) console.warn('whisper-server.exe is not in this release: voice works, without the resident server.');

  const wantSmall = process.argv.includes('--small');
  const modelUrl = wantSmall ? MODEL_SMALL_URL : MODEL_BASE_URL;
  const modelPath = path.join(modelDir, path.basename(new URL(modelUrl).pathname));
  if (!fs.existsSync(modelPath)) await download(modelUrl, modelPath);
  console.log(`Model ready: ${modelPath}`);
  console.log('Voice setup complete.');
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
