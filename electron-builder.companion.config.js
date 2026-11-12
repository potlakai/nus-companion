const base = require('./electron-builder.config.js');
// The publik switch: Sign in with publik, usage counting and publik API (companion/src/publik).
// true for the build listed on publik. false builds the Companion as it was in 0.1.16: no gate,
// no publik provider, and the folder and the app token stay out of the installer.
const PUBLIK = true;
module.exports = {
  appId: 'com.nus.companion',
  productName: 'Nus Companion',
  copyright: base.copyright,
  extraMetadata: { name: 'nus-companion', version: '0.1.21', main: 'src/main-companion.js', publik: PUBLIK,
    description: 'Nūs Companion: the Knot that hears you and acts, on its own.' },
  directories: { output: 'dist-companion', buildResources: 'build' },
  // companion/** carries companion/src/stats.js (anonymous usage stats, plain
  // fetch, no SDK); @supabase and electron-updater stay out of this build.
  // src/license.js (no requires) reads the optional account's plan.
  files: ['companion/**/*', 'src/main-companion.js', 'src/ai.js', 'src/claude-pool.js', 'src/secrets.js', 'src/stt-local.js', 'src/whisper-server.js',
    'src/crash.js', 'src/quit-guard.js', 'src/db.js', 'src/license.js', 'package.json',
    '!**/*.test.js', '!**/*.bak-*', '!companion/test/**', '!docs/**', '!scripts/**', '!supabase/**',
    // Developer-only checks and the unused 3D Knot stay out of the asar.
    '!companion/verify-focus-guard.cjs', '!companion/renderer/knot3d.js',
    '!renderer/**', '!src/config.js', '!electron-builder*.config.js',
    // publik: the module finds publik-app-token.txt in its folder or a parent (the asar root).
    ...(PUBLIK ? ['publik-app-token.txt'] : ['!companion/src/publik/**']),
    '!node_modules/@supabase/**', '!node_modules/electron-updater/**',
    // Local embeddings (companion/src/recall/embed.js): the Windows x64 runtime only.
    '!node_modules/onnxruntime-node/bin/napi-v*/darwin/**', '!node_modules/onnxruntime-node/bin/napi-v*/linux/**', '!node_modules/onnxruntime-node/bin/napi-v*/win32/arm64/**',
    // CPU only: the GPU (DirectML) libraries are not loaded for this model.
    '!node_modules/onnxruntime-node/bin/napi-v*/win32/x64/DirectML.dll', '!node_modules/onnxruntime-node/bin/napi-v*/win32/x64/dx*.dll'],
  // The voice runtime (sherpa-onnx, N-API) must sit on disk, not inside the asar, to load.
  asarUnpack: ['companion/src/win/ocr.ps1', 'node_modules/onnxruntime-node/**', 'node_modules/sherpa-onnx-node/**', 'node_modules/sherpa-onnx-win-x64/**', 'companion/src/voice/engine-worker.js'],
  win: {
    target: base.win.target, icon: 'build/icon.ico', artifactName: 'Nus-Companion-Setup.${ext}',
    extraResources: [...base.win.extraResources,
      { from: 'companion/src/reflex', to: 'win', filter: ['hands.ps1'] },
      // Fable, the Knot's own voice (Kokoro v1.0 via sherpa-onnx, Apache-2.0; espeak-ng-data is
      // GPL-3.0, see THIRD-PARTY.md), so the first word is Fable with no download. The English files only.
      { from: 'vendor/voice/kokoro-multi-lang-v1_0', to: 'voice/kokoro-multi-lang-v1_0', filter: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-gb-en.txt', 'lexicon-us-en.txt', 'LICENSE', 'espeak-ng-data/**'] },
      { from: 'vendor/whisper-models', to: 'whisper-models', filter: ['ggml-base.en-q5_1.bin'] },
      // all-MiniLM-L6-v2, int8 ONNX (Apache-2.0): search by meaning. npm run setup:embed fetches it.
      { from: 'vendor/embed-models', to: 'embed-models', filter: ['all-MiniLM-L6-v2/model_quantized.onnx', 'all-MiniLM-L6-v2/vocab.txt'] }],
  },
  portable: { artifactName: 'Nus-Companion-Portable.${ext}' },
  nsis: { ...base.nsis, shortcutName: 'Nus Companion', uninstallDisplayName: 'Nūs Companion' },
  publish: [{ provider: 'github', owner: 'potlakai', repo: 'nus-companion' }],
};
