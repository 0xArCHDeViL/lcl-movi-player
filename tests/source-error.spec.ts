import { test, expect } from "@playwright/test";
import { serveFlaky } from "./fixtures/flaky-server";
import { servePlayerPage } from "./fixtures/page";

/**
 * What a URL that starts refusing MID-PLAYBACK does to the player.
 *
 * The file is served by us, properly: real `206 Partial Content` with a correct
 * `Content-Range`, streaming for as long as the player wants it. Only once it
 * has genuinely been playing — a live window, a demuxer reading ahead of the
 * playhead — does the server start answering 403, the way a signed URL does
 * when its signature expires.
 *
 * Before the fix that produced a retry storm and nothing else: 1131 requests in
 * five seconds, the state still "playing", no error anywhere. Each retry
 * cleared the error the previous one had recorded, so none survived to be
 * thrown, and read() answered every uncovered window by opening another fetch.
 *
 * Run it headed to watch the whole thing happen:
 *
 *   npx playwright test tests/source-error.spec.ts --headed
 */

const MEDIA_FILE =
  process.env.MOVI_TEST_MEDIA ??
  "/Users/ujjawalkashyap/Downloads/Videos/Dhamaal 4： Saree (Full Video) ｜ Sanju Rathod,Tanishk ｜ Ajay D,Ritiesh Deshmukh,Anjali,Arshad,Jaaved.mkv";

/** Three spaced attempts is what HttpSource spends before it stops asking, and
 *  the element retries the whole thing a few times on top. Anything near this
 *  is a budget; the storm was two orders of magnitude past it. */
const STORM_CEILING = 60;

test("a source that starts refusing mid-playback is asked a few times, then reported", async ({
  page,
}) => {
  const media = await serveFlaky(MEDIA_FILE);
  const host = await servePlayerPage();

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  try {
    await page.goto(host.url(media.url), { waitUntil: "domcontentloaded" });

    // Play for real, on 206s.
    await page.waitForFunction(
      () => ((document.querySelector("movi-player") as any)?.player?.getCurrentTime?.() ?? 0) > 3,
      undefined,
      { timeout: 60_000 },
    );
    const servedOk = media.log.filter((r) => r.status === 206).length;
    expect(servedOk).toBeGreaterThan(0);

    // …and now the URL goes bad, exactly the way an expired signature does.
    media.breakNow(403);
    const brokeAt = media.log.length;

    // No seek: playback simply walks off the end of what it already holds. A
    // seek gave the demuxer a chance to satisfy itself from cached bytes, and
    // it took it — which is the player being right, not the test working.

    // What the viewer ends up being told. Polled rather than waited on, so a
    // run that never gets there reports what it DID end up in instead of a
    // timeout that says nothing.
    let shown = "";
    let settled: Record<string, unknown> = {};
    for (let i = 0; i < 60 && !shown; i++) {
      await page.waitForTimeout(1000);
      const probe = await page.evaluate(() => {
        const el = document.querySelector("movi-player") as any;
        const node = el?.shadowRoot?.querySelector(
          ".movi-broken-indicator",
        ) as HTMLElement | null;
        const visible = node && getComputedStyle(node).display !== "none";
        return {
          text: visible ? (node.innerText || "").replace(/\s+/g, " ").trim() : "",
          state: el?.player?.getState?.(),
          time: el?.player?.getCurrentTime?.(),
        };
      });
      shown = probe.text;
      settled = probe;
    }

    const refused = media.log.slice(brokeAt);
    console.log(`served on 206 before the break: ${servedOk}`);
    console.log(`refused requests after it: ${refused.length}`);
    console.log(`at (ms): ${refused.map((r) => r.at).join(", ")}`);
    console.log(`the viewer is told: ${shown || "(nothing)"}`);
    console.log(`settled on: ${JSON.stringify(settled)}`);

    // Headed, the window stays until it is closed by hand. The assertions below
    // take microseconds, and the interesting part of this test is the thing on
    // screen: the message, and what the Retry button does with a source that is
    // still refusing. Close the window to let the run finish.
    if (test.info().project.use.headless === false) {
      test.setTimeout(0);
      console.log("--- headed: press Retry, look around, then CLOSE THE WINDOW to end the run ---");
      await page.waitForEvent("close", { timeout: 0 });
    }

    // The storm is the regression.
    expect(refused.length).toBeLessThan(STORM_CEILING);
    // And it does not end in silence.
    expect(shown.length).toBeGreaterThan(0);
  } finally {
    if (!page.isClosed()) await page.close();
    await host.close();
    await media.close();
  }
});
