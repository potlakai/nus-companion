const fs = require('fs');
const path = require('path');

function formatFailure(kind, error, detail = {}) {
  const value = error instanceof Error ? (error.stack || error.message) : String(error);
  return [
    `[${new Date().toISOString()}] ${kind}`,
    `platform=${process.platform} arch=${process.arch} node=${process.version}`,
    ...Object.entries(detail).map(([key, item]) => `${key}=${String(item)}`),
    value,
    '',
  ].join('\n');
}

function isIgnorablePipeError(error) {
  return error?.code === 'EPIPE' && error?.syscall === 'write';
}

function installCrashHandlers(app, dialog) {
  const logDir = path.join(app.getPath('userData'), 'logs');
  const logFile = path.join(logDir, 'crash.log');
  let handlingFatal = false;
  // Set later by the host (the stats module is built after these handlers):
  // called with the kind of a real crash, before the dialog, so a count can
  // go out while the error box waits. Never the error itself.
  let onCrash = null;

  function record(kind, error, detail) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, formatFailure(kind, error, detail), { encoding: 'utf8', mode: 0o600 });
    } catch {}
    if (kind === 'uncaughtException' || kind === 'render-process-gone') { try { onCrash?.(kind); } catch {} }
  }

  process.on('uncaughtException', (error, origin) => {
    // A detached packaged process can outlive the terminal that launched it.
    // Losing stdout is not an application crash and must never close Nūs.
    if (isIgnorablePipeError(error)) { record('stdout-closed', error, { origin }); return; }
    if (handlingFatal) return;
    handlingFatal = true;
    record('uncaughtException', error, { origin });
    try { dialog.showErrorBox('Nūs stopped unexpectedly', `A crash log was saved here:\n${logFile}\n\nRestart Nūs, and send this file with your bug report.`); } catch {}
    app.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    record('unhandledRejection', reason);
    console.error('[nus] unhandled promise rejection', reason);
  });

  app.on('render-process-gone', (_event, _contents, details) => {
    record('render-process-gone', details?.reason || 'unknown', details || {});
  });
  app.on('child-process-gone', (_event, details) => {
    record('child-process-gone', details?.type || 'unknown', details || {});
  });

  return { logFile, record, setOnCrash(fn) { onCrash = typeof fn === 'function' ? fn : null; } };
}

module.exports = { installCrashHandlers, formatFailure, isIgnorablePipeError };
