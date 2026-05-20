/**
 * Shared helpers for the three smoke scripts
 * (drill-loop-smoke, drill-loop-browser-smoke, realtime-webrtc-smoke).
 *
 * Scope is deliberately minimal — only the functions that were truly
 * identical across all three are deduped. Things that varied per script
 * (startProcess env handling, fetchJson timeout, audio file selection)
 * stay inline in each smoke so individual smokes can keep tuning.
 */

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url, maxMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function httpOk(url) {
  try {
    const res = await fetchWithTimeout(url, 1000);
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForHttp(url, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await httpOk(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
