import { createServer, type Server } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";

/**
 * A file server that plays fair and then stops.
 *
 * It serves real `206 Partial Content` with a correct `Content-Range` for as
 * long as it is told to, and after that answers every byte request with a
 * chosen status. That is the shape of a signed URL expiring mid-playback: the
 * file opens, plays, and then the next chunk — and every chunk after it —
 * comes back 403.
 *
 * Faking this with a route interceptor is not the same thing: the point is a
 * source that was genuinely streaming, with a live window and a demuxer reading
 * ahead of the playhead, when the refusals start.
 */
export interface FlakyServer {
  url: string;
  /** Start refusing every further byte request with this status. */
  breakNow(status?: number): void;
  /** Every request the player has made, in order, with what it got back. */
  log: { at: number; range: string | undefined; status: number }[];
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * The player caches a whole file when it fits its budget (520MB), and a file it
 * has entirely in memory does not care what the server says next — the refusals
 * would land on a source with nothing left to ask for. So the server reports a
 * size above that budget, which is what puts HttpSource on a sliding window and
 * keeps it streaming. Bytes past the real file are served as zeros; nothing
 * reads that far before the break, and a container that cannot find its index
 * out there still opens and plays.
 */
const VIRTUAL_SIZE = 900 * 1024 * 1024;

/**
 * …and it hands the bytes over at a rate, not as fast as a local disk can.
 *
 * Unthrottled, this server filled the player's whole cache within seconds of
 * opening — so by the time the refusals started there was nothing left to ask
 * for, and the player rightly played on through all of them. A source that has
 * everything cannot demonstrate what happens when a source stops answering. Two
 * megabytes a second is a plausible link and keeps the player reading.
 */
const BYTES_PER_SECOND = 2 * 1024 * 1024;
const CHUNK = 64 * 1024;

export async function serveFlaky(filePath: string): Promise<FlakyServer> {
  const realSize = statSync(filePath).size;
  const size = Math.max(realSize, VIRTUAL_SIZE);
  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const started = Date.now();
  const log: FlakyServer["log"] = [];
  let broken = 0;

  const server: Server = createServer((req, res) => {
    // The player asks from another origin (the test page is served from a
    // different port), and it reads Content-Range and Content-Length.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "content-range, content-length, accept-ranges");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "range");
      res.writeHead(204).end();
      return;
    }

    const range = req.headers.range as string | undefined;

    if (broken) {
      log.push({ at: Date.now() - started, range, status: broken });
      res.writeHead(broken, { "Content-Type": "text/plain" }).end("expired");
      return;
    }

    if (req.method === "HEAD") {
      log.push({ at: Date.now() - started, range, status: 200 });
      res.writeHead(200, { "Content-Length": String(size), "Content-Type": type }).end();
      return;
    }

    if (!range) {
      log.push({ at: Date.now() - started, range, status: 200 });
      res.writeHead(200, { "Content-Length": String(size), "Content-Type": type });
      createReadStream(filePath).pipe(res);
      return;
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? parseInt(m[1], 10) : 0;
    // Cap the span so a bare `bytes=N-` does not try to hand over the whole
    // claimed size in one response.
    const asked = m?.[2] ? parseInt(m[2], 10) : start + 8 * 1024 * 1024 - 1;
    const end = Math.min(asked, size - 1);
    if (start >= size) {
      log.push({ at: Date.now() - started, range, status: 416 });
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    log.push({ at: Date.now() - started, range, status: 206 });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Content-Type": type,
    });
    void sendThrottled(res, filePath, start, end, realSize);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/media`,
    breakNow: (status = 403) => {
      broken = status;
    },
    log,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}


/** Write the range out at BYTES_PER_SECOND, so the player has to keep asking. */
async function sendThrottled(
  res: import("node:http").ServerResponse,
  filePath: string,
  start: number,
  end: number,
  realSize: number,
): Promise<void> {
  const delayPerChunk = (CHUNK / BYTES_PER_SECOND) * 1000;
  let at = start;
  try {
    while (at <= end && !res.destroyed) {
      const stop = Math.min(at + CHUNK - 1, end);
      let buf: Buffer;
      if (at >= realSize) {
        buf = Buffer.alloc(stop - at + 1);
      } else {
        const realStop = Math.min(stop, realSize - 1);
        buf = await readSlice(filePath, at, realStop);
        if (stop > realStop) buf = Buffer.concat([buf, Buffer.alloc(stop - realStop)]);
      }
      if (!res.write(buf)) {
        await new Promise<void>((r) => res.once("drain", () => r()));
      }
      at = stop + 1;
      await new Promise((r) => setTimeout(r, delayPerChunk));
    }
  } catch {
    /* client went away mid-write */
  }
  if (!res.destroyed) res.end();
}

function readSlice(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const s = createReadStream(filePath, { start, end });
    s.on("data", (c) => parts.push(c as Buffer));
    s.on("end", () => resolve(Buffer.concat(parts)));
    s.on("error", reject);
  });
}
