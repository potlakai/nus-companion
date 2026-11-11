const DEBUG = false; // Set to false to disable debug logging
// LLM factory: OpenAI / Anthropic / Gemini behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, baseURL, signal }) {
  if (DEBUG) console.log('[DEBUG LLM] streamOpenAI called', { model, baseURL, hasImage: !!imageDataUrl, maxTokens });
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  if (DEBUG) console.log('[DEBUG LLM] streamOpenAI sending request to OpenAI SDK with messages count:', messages.length);
  try {
    // signal: a stop (Esc, "stop") closes the stream instead of letting the
    // reply run to completion (2026-10-31; the Anthropic and Gemini paths already did).
    const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens }, signal ? { signal } : undefined);
    let full = '';
    for await (const part of stream) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
      if (d) { full += d; onToken(d); }
    }
    if (DEBUG) console.log('[DEBUG LLM] streamOpenAI finished successfully, total length:', full.length);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamOpenAI error:', err);
    throw err;
  }
}

// effort: 'low' | 'medium' | 'high' | ... (output_config.effort). Current Claude
// models think by default and the thinking counts against max_tokens, so a
// small budget can come back with no text at all: the floor below is for that.
async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken = () => {}, effort, signal, onUsage, assignment }) {
  if (DEBUG) console.log('[DEBUG LLM] streamAnthropic called', { model, hasImage: !!imageDataUrl, maxTokens });
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, ...(assignment ? { maxRetries: 0, timeout: 60000 } : {}) });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  if (DEBUG) console.log('[DEBUG LLM] streamAnthropic sending request to Anthropic SDK with messages count:', messages.length);
  try {
    // The system prompt is marked for the prompt cache: it is the same on every
    // guide step and every walkthrough problem, so only the screenshot and the
    // question are read fresh. Keep anything that changes per turn out of it.
    const cachedSystem = system ? [{ type: 'text', text: String(system), cache_control: { type: 'ephemeral' } }] : undefined;
    const request = { model, max_tokens: assignment ? Number(maxTokens) || 4096 : Math.max(Number(maxTokens) || 0, 4096), system: cachedSystem, messages, stream: true };
    if (effort && !/haiku/i.test(model)) request.output_config = { effort: String(effort) };
    const stream = await client.messages.create(request, { signal });
    let full = '';
    let usage = {}, stopReason = '';
    for await (const ev of stream) {
      if (ev.type === 'message_start') usage = { ...usage, ...ev.message.usage };
      if (ev.type === 'message_delta') { usage = { ...usage, ...ev.usage }; stopReason = ev.delta?.stop_reason || stopReason; }
      if (ev.type === 'message_delta' && onUsage && usage.input_tokens != null && usage.output_tokens != null) onUsage(usage);
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
    }
    if (assignment && stopReason && stopReason !== 'end_turn') throw new Error('incomplete model reply: ' + stopReason);
    if (DEBUG) console.log('[DEBUG LLM] streamAnthropic finished successfully, total length:', full.length);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamAnthropic error:', err);
    throw err;
  }
}

// Same contract as streamAnthropic: signal aborts the losing lane, json asks
// for a JSON object, onUsage settles the spend ledger, assignment refuses a
// truncated reply. Until 2026-09-30 all four were dropped on the floor here,
// so a Gemini-key assignment run could neither cancel nor settle.
async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, signal, json, onUsage, assignment }) {
  if (DEBUG) console.log('[DEBUG LLM] streamGemini called', { model, hasImage: !!imageDataUrl, maxTokens });
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  if (DEBUG) console.log('[DEBUG LLM] streamGemini sending request to Google SDK with contents count:', contents.length);
  try {
    const config = { systemInstruction: system };
    if (signal) config.abortSignal = signal;
    if (maxTokens) config.maxOutputTokens = Math.max(Number(maxTokens) || 0, 1024);
    if (json) config.responseMimeType = 'application/json';
    // Flash thinks by default and the thinking is paid in silence before the
    // first token (completeGemini already turns it off, 2026-09-15). The chat
    // panel and other stream callers get the same rule; an assignment lane
    // keeps thinking, that is what it is for.
    if (!assignment && /flash/i.test(String(model))) config.thinkingConfig = { thinkingBudget: 0 };
    const stream = await ai.models.generateContentStream({ model, contents, config });
    let full = '';
    let lastFinishReason = 'UNKNOWN';
    let usage = null;
    for await (const chunk of stream) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const t = chunk && chunk.text;
      if (t) { full += t; onToken(t); }
      if (chunk && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason) {
        lastFinishReason = chunk.candidates[0].finishReason;
      }
      const u = chunk && chunk.usageMetadata;
      if (u && Number.isFinite(u.promptTokenCount) && Number.isFinite(u.candidatesTokenCount)) usage = { input_tokens: u.promptTokenCount, output_tokens: u.candidatesTokenCount };
    }
    if (usage && onUsage) onUsage(usage);
    if (assignment && lastFinishReason && !/^(STOP|UNKNOWN)$/.test(lastFinishReason)) throw new Error('incomplete model reply: ' + lastFinishReason);
    if (DEBUG) console.log('[DEBUG LLM] streamGemini finished successfully, total length:', full.length, 'finishReason:', lastFinishReason);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamGemini error:', err);
    throw err;
  }
}

// One non-streaming answer. json:true asks the provider for a JSON object
// where the SDK supports it (Gemini); elsewhere the prompt carries the
// contract and the caller parses tolerantly. Used for pointing, where a
// small, fast, structured reply matters more than tokens on screen.
async function completeGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, json, onDelta, signal }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  // Gemini 3.x Flash thinks by default and the thinking counts against
  // maxOutputTokens: a 400-token budget came back as an EMPTY reply on every
  // guide step (2026-09-15). Thinking off for Flash, and a floor on the budget.
  const config = { systemInstruction: system, maxOutputTokens: Math.max(Number(maxTokens) || 0, 1024), temperature: 0.2 };
  if (/flash/i.test(String(model))) config.thinkingConfig = { thinkingBudget: 0 };
  if (json) config.responseMimeType = 'application/json';
  if (signal) config.abortSignal = signal;
  // A caller that can use text as it arrives (the guide speaks sentences
  // while the tags are still being written) gets the stream; the same config.
  if (typeof onDelta === 'function' && !json) {
    const stream = await ai.models.generateContentStream({ model, contents, config });
    let full = '';
    for await (const chunk of stream) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const t = chunk && chunk.text;
      if (t) { full += t; onDelta(t); }
    }
    return full;
  }
  const res = await ai.models.generateContent({ model, contents, config });
  return (res && typeof res.text === 'string') ? res.text : (res && res.text) || '';
}

function createLLM(settings) {
  // NUS_COMPANION_CLAUDE_API=1 (launch-day1.ps1 -ClaudeApi): Claude through the
  // ANTHROPIC_API_KEY already in the environment, whatever the settings say.
  // Opt-in because it spends API credits; the key is never written to settings.
  const envClaude = process.env.NUS_COMPANION_CLAUDE_API === '1' && !!process.env.ANTHROPIC_API_KEY;
  const provider = envClaude ? 'anthropic' : settings.provider;
  const keys = settings.apiKeys || {};
  const apiKey = envClaude ? process.env.ANTHROPIC_API_KEY : keys[provider];
  const tier = settings.smart ? 'smart' : 'fast';
  const model = envClaude ? (process.env.NUS_COMPANION_CLAUDE_MODEL || 'claude-sonnet-5') : (settings.models[provider] || {})[tier];

  // Set to 4096 (effectively unlimited for a single response) 
  // since some SDKs like Anthropic require a maxTokens value.
  const maxTokens = 4096;

  if (DEBUG) console.log('[DEBUG LLM] createLLM initialized:', { provider, model, isKeyPresent: !!apiKey, ready: !!apiKey && !!model });

  return {
    provider, model, apiKey,
    ready: !!apiKey && !!model,
    async stream(params) {
      if (DEBUG) console.log('[DEBUG LLM] stream() invoked for provider:', provider);
      const args = { apiKey, model, maxTokens, ...params };
      if (provider === 'openai') return streamOpenAI(args);
      if (provider === 'nvidia') return streamOpenAI({ ...args, baseURL: 'https://integrate.api.nvidia.com/v1' });
      if (provider === 'anthropic') return streamAnthropic(args);
      if (provider === 'gemini') return streamGemini(args);
      throw new Error('unknown provider: ' + provider);
    },
    async complete(params) {
      // params.model: one call on another model of the same provider (a problem
      // walkthrough wants the smart tier). Unset leaves the configured one.
      // params.onDelta: streamed text for callers that can use it as it arrives.
      const args = { apiKey, maxTokens: params.maxTokens || 512, ...params, model: params.model || model, onToken: params.onToken || params.onDelta || (() => {}) };
      if (provider === 'gemini') return completeGemini(args);
      // The other SDKs stream fine; collect and return.
      if (provider === 'openai') return streamOpenAI(args);
      if (provider === 'nvidia') return streamOpenAI({ ...args, baseURL: 'https://integrate.api.nvidia.com/v1' });
      if (provider === 'anthropic') return streamAnthropic(args);
      throw new Error('unknown provider: ' + provider);
    }
  };
}

module.exports = { createLLM };
