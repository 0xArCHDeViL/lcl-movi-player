import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests that drive a real player.
 *
 * These are not unit tests — they open a page, play a video and interfere with
 * the network to see what the player does about it. Run them headed to watch:
 *
 *   npx playwright test --headed
 *
 * They need an app serving the player. `tests/source-error.spec.ts` uses
 * movi-tube (npm run dev in ../movi-tube); point MOVI_TUBE_URL elsewhere to use
 * a different one.
 */
export default defineConfig({
  testDir: "./tests",
  // One at a time: each test plays real video and competes for the link.
  workers: 1,
  fullyParallel: false,
  // These wait on real playback, so they are slow by nature rather than by
  // fault — a short timeout would just make them flaky.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    // The dev server serves https with a self-signed certificate.
    ignoreHTTPSErrors: true,
    // Autoplay with sound, so the run does not stall waiting for a gesture
    // that a test cannot give.
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
    video: "off",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
