# Agents working on the Nūs Companion

## publik API
- Base URL: https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages)
- Models: publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Sign in with publik: the publik module's gate runs at start-up, before the first screen; it also sends usage telemetry
- Key: per-install `pk_` from POST /installs, stored at the publik credential path; env PUBLIK_API_KEY / PUBLIK_API_BASE_URL override
- App token: publik-app-token.txt (public by design, committed) or PUBLIK_APP_TOKEN
- 402: show error.message plus error.top_up_url only
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md

## Where publik lives in this repo
- Everything is in `companion/src/publik/`: `publik.js` (Publik's reference module as CommonJS),
  `gate-window.js` + `gate.html` + `gate-preload.js` (the gate's window), `index.js` (the switch,
  the provider, the error words).
- Outside it: the gate call at the top of `app.whenReady` in `src/main-companion.js`, the
  `publik` provider branch in `companion/src/llm.js`, the 402 line in `companion/src/ask-error.js`,
  the Top up button in `companion/index.js`, the tour's card in `companion/src/tour.js`, and the
  Settings switch in `companion/home/`.
- The build switch: `PUBLIK` in `electron-builder.companion.config.js`. Never weaken or skip the
  gate in a build with the switch on.
