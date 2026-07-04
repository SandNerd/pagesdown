// Lightweight error helper utilities for NotionDrive
export function wrapError(message, cause) {
  const err = new Error(message);
  try { if (cause) err.cause = cause; } catch (e) {}
  return err;
}

export function isAbortError(err) {
  if (!err) return false;
  try {
    if (err.name === 'AbortError') return true;
    if (typeof err.code === 'string' && err.code === 'ABORT_ERR') return true;
    return false;
  } catch (e) {
    return false;
  }
}

export function formatErrorForLogging(err, { debug = false } = {}) {
  if (!err) return String(err);
  if (debug) return err.stack || err.message || String(err);
  let out = err.message || String(err);
  try {
    if (err.cause) {
      const c = err.cause;
      const causeMsg = c && (c.message || String(c));
      if (causeMsg) out += `\nCaused by: ${causeMsg}`;
    }
  } catch (e) {}
  return out;
}
