import { writeFile } from 'node:fs/promises';
import { wrapError, isAbortError } from './error.js';

// Default constants mirror src/download.js defaults
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BACKOFF = 150;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50 MB

// Block private/internal IP ranges to prevent SSRF when downloading assets
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const PRIVATE_IP_PREFIXES = ['10.', '192.168.', '169.254.', '172.16.', '172.17.', '172.18.',
  '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
  '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];

export function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (BLOCKED_HOSTNAMES.has(hostname)) return false;
    if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return false;
    return true;
  } catch {
    return false;
  }
}

function backoffDelay(ms) {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      try { clearTimeout(id); } catch (e) {}
      resolve();
    }, ms);
  });
}

function createTimedSignal(parentSignal, timeoutMs) {
  if (parentSignal && parentSignal.signal) parentSignal = parentSignal.signal;
  if (parentSignal && parentSignal.aborted) return { signal: parentSignal, cleanup: null };
  const controller = new AbortController();
  const id = setTimeout(() => {
    try { controller.abort(); } catch (e) {}
  }, timeoutMs);
  if (parentSignal) {
    // If the parent signal aborts, abort our controller
    const onAbort = () => controller.abort();
    try { parentSignal.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
    return { signal: controller.signal, cleanup: () => { try { clearTimeout(id); } catch (e) {} } };
  }
  return { signal: controller.signal, cleanup: () => { try { clearTimeout(id); } catch (e) {} } };
}

export async function downloadToPath(url, destPath, { parentSignal = null, retries = DEFAULT_RETRIES, backoff = DEFAULT_BACKOFF, timeoutMs = DEFAULT_TIMEOUT_MS, maxSize = DEFAULT_MAX_SIZE } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal, cleanup } = createTimedSignal(parentSignal, timeoutMs);
    try {
      if (!isAllowedUrl(url)) {
        try { cleanup && cleanup(); } catch (e) {}
        throw new Error('Disallowed URL');
      }
      const res = await fetch(url, { signal }).catch((err) => {
        if (isAbortError(err)) throw err;
        throw wrapError(`HTTP request failed for ${url}`, err);
      });

      if (!res.ok) {
        if (res.status >= 500 && res.status < 600 && attempt < retries) {
          try { cleanup && cleanup(); } catch (e) {}
          await backoffDelay(backoff * Math.pow(2, attempt));
          continue;
        }
        try { cleanup && cleanup(); } catch (e) {}
        throw new Error(`HTTP ${res.status}`);
      }

      // Early reject if Content-Length is known and too large
      const rawLength = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
      const contentLength = rawLength ? parseInt(rawLength, 10) : NaN;
      if (!Number.isNaN(contentLength) && contentLength > maxSize) {
        try { cleanup && cleanup(); } catch (e) {}
        throw new Error(`File too large (${Math.round(contentLength / 1024 / 1024)}MB, limit ${Math.round(maxSize / 1024 / 1024)}MB)`);
      }

      const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
      if (!reader) {
        try { cleanup && cleanup(); } catch (e) {}
        throw new Error('No response body');
      }

      const chunks = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += (value && value.length) || (value && value.byteLength) || 0;
        if (totalBytes > maxSize) {
          try { await reader.cancel(); } catch (err) {}
          try { controllerAbort(signal); } catch (err) {}
          throw new Error(`File too large (exceeded ${Math.round(maxSize / 1024 / 1024)}MB during download)`);
        }
        chunks.push(value);
      }

      await writeFile(destPath, Buffer.concat(chunks));

      try { cleanup && cleanup(); } catch (e) {}

      // Best-effort cleanup of reader / response body
      try {
        if (reader) {
          try { await reader.cancel(); } catch (err) {}
          try { if (typeof reader.releaseLock === 'function') reader.releaseLock(); } catch (err) {}
        }
      } catch (err) {}

      try {
        if (res && res.body) {
          if (typeof res.body.cancel === 'function') {
            try { await res.body.cancel(); } catch (err) {}
          } else if (typeof res.body.destroy === 'function') {
            try { res.body.destroy(); } catch (err) {}
          }
        }
      } catch (err) {}

      return;
    } catch (err) {
      lastErr = err;
      try { cleanup && cleanup(); } catch (e) {}
      if (err && (isAbortError(err) || isAbortError(err.cause))) throw err;
      if (isNonRetryableError(err)) throw err;
      if (attempt === retries) throw lastErr;
      await backoffDelay(backoff * Math.pow(2, attempt));
    }
  }

  throw lastErr || new Error('downloadToPath failed');
}

function controllerAbort(signal) {
  try {
    if (signal && typeof signal.abort === 'function') signal.abort();
  } catch (e) {}
}

function isNonRetryableError(err) {
  const msg = (err && err.message) ? String(err.message) : '';
  if (!msg) return false;
  if (msg === 'Disallowed URL') return true;
  if (msg === 'No response body') return true;
  if (msg.startsWith('File too large')) return true;

  const httpMatch = msg.match(/^HTTP\s+(\d{3})$/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return Number.isFinite(status) ? status < 500 : false;
  }

  return false;
}
