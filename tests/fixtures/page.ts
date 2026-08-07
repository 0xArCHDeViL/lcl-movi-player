import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The smallest page that is a real player: the built element, one source, and
 * nothing else to explain a result away.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const BUNDLE = resolve(ROOT, "dist/element.slim.js");
const WASM = resolve(ROOT, "dist/movi.wasm");

export interface PagePlayer {
  url: (mediaUrl: string) => string;
  close: () => Promise<void>;
}

export async function servePlayerPage(): Promise<PagePlayer> {
  if (!existsSync(BUNDLE)) {
    throw new Error(`dist not built — run npm run build:ts (missing ${BUNDLE})`);
  }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/element.slim.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync(BUNDLE));
      return;
    }
    if (url.pathname === "/movi.wasm") {
      res.writeHead(200, { "Content-Type": "application/wasm" }).end(readFileSync(WASM));
      return;
    }
    const media = url.searchParams.get("media") ?? "";
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html>
<meta charset="utf-8">
<title>movi source-failure harness</title>
<style>
  html, body { margin: 0; background: #111; color: #eee; font: 14px system-ui; }
  movi-player { width: 100vw; height: 100vh; display: block; }
</style>
<movi-player
  id="p"
  src="${media}"
  wasmurl="/movi.wasm"
  controls
  autoplay
  muted
  renderer="canvas"
></movi-player>
<script type="module" src="/element.slim.js"></script>
`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (mediaUrl: string) => `http://127.0.0.1:${port}/?media=${encodeURIComponent(mediaUrl)}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
