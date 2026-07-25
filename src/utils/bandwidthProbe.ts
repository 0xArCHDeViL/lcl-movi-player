/**
 * A quick, standalone link-speed test.
 *
 * The naive "fetch a slice and time it" measures the wrong thing through a
 * caching/buffering proxy (movi-tube's `/api/stream/media`, a CDN edge, a
 * Service Worker): the FIRST couple of megabytes come out of the proxy's
 * read-ahead buffer almost instantly — 600+ MB/s bursts show up in the logs —
 * and only AFTER that does the stream throttle down to the real origin rate. A
 * probe that stops inside the burst reads a fantasy number and picks a rung the
 * link can't actually carry.
 *
 * So this streams the response and IGNORES the burst: it starts its stopwatch
 * only once `SKIP_BYTES` have already arrived, then times how long the next
 * `MEASURE_BYTES` take (or whatever lands before the wall-clock cap). That tail
 * is the sustained rate. It downloads a few MB at most and aborts the moment it
 * has its answer — never the whole file.
 */
export interface BandwidthProbeOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Bytes to discard as the proxy/CDN burst before measuring. */
  skipBytes?: number;
  /** Bytes to time after the burst for the sustained reading. */
  measureBytes?: number;
  /** Hard wall-clock cap (ms) so a very slow link still returns something. */
  timeoutMs?: number;
}

const DEFAULT_SKIP_BYTES = 2_500_000; // past the ~2 MB proxy read-ahead burst
const DEFAULT_MEASURE_BYTES = 1_500_000; // ~1.5 MB of real, throttled stream
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Measure sustained link throughput in BITS/second, or -1 if it couldn't get a
 * trustworthy reading (fetch failed, file too small to clear the burst, or the
 * measured window was too short to be meaningful). Never throws.
 */
export async function probeLinkBandwidth(
  url: string,
  opts: BandwidthProbeOptions = {},
): Promise<number> {
  const skipBytes = opts.skipBytes ?? DEFAULT_SKIP_BYTES;
  const measureBytes = opts.measureBytes ?? DEFAULT_MEASURE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wantBytes = skipBytes + measureBytes;

  // Our own timeout, combined with any caller signal, so a stalled link can't
  // hang the probe forever.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${wantBytes - 1}`, ...(opts.headers || {}) },
      signal: ac.signal,
    });
    if ((!res.ok && res.status !== 206) || !res.body) return -1;

    reader = res.body.getReader();
    let received = 0;
    let firstByteAt = 0; // time the first chunk arrived
    // Stopwatch state for the post-burst (sustained) window.
    let measureStart = 0;
    let measureStartBytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      const now = performance.now();
      if (done) break;
      if (!value) continue;
      if (firstByteAt === 0) firstByteAt = now;
      received += value.length;

      // Arm the post-burst stopwatch the first time we cross the burst
      // boundary. Note the chunk that crosses it may carry bytes past the
      // boundary too — measuring from `received` here just means the window is
      // slightly conservative, which is fine.
      if (measureStart === 0 && received >= skipBytes) {
        measureStart = now;
        measureStartBytes = received;
        continue;
      }
      // Enough sustained data timed — return that rate.
      if (measureStart !== 0 && received - measureStartBytes >= measureBytes) {
        const seconds = (now - measureStart) / 1000;
        const bytes = received - measureStartBytes;
        if (seconds > 0) return (bytes / seconds) * 8;
      }
    }

    // Stream ended (or timed out). Prefer the post-burst window if it gathered
    // a usable sample...
    const end = performance.now();
    if (measureStart !== 0) {
      const seconds = (end - measureStart) / 1000;
      const bytes = received - measureStartBytes;
      if (bytes >= 262144 && seconds >= 0.15) return (bytes / seconds) * 8;
    }
    // ...otherwise fall back to the WHOLE-download rate. This is the fast-link
    // case: the requested range arrived in one/few big chunks, so there was no
    // throttled tail to isolate — which only happens when the link delivered it
    // all quickly, i.e. it IS fast, so the (burst-inclusive) whole rate is a
    // fair, high reading. A throttled link instead produces a slow tail and
    // takes the post-burst path above.
    if (firstByteAt !== 0 && received >= 500_000) {
      const seconds = (end - firstByteAt) / 1000;
      if (seconds >= 0.1) return (received / seconds) * 8;
    }
    return -1;
  } catch {
    return -1; // aborted / network error — caller falls back to passive measure
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    try {
      await reader?.cancel();
    } catch {
      /* noop */
    }
  }
}
