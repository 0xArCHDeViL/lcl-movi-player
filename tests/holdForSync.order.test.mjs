import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("holdForSync freezes the running timeline before awaiting the target seek", async () => {
  const source = await readFile(new URL("../src/core/MoviPlayer.ts", import.meta.url), "utf8");
  const methodStart = source.indexOf("async holdForSync(targetTime: number): Promise<void>");
  const methodEnd = source.indexOf("/** Release an already primed target", methodStart);
  const method = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0, "holdForSync must remain available to the element bridge");
  assert.ok(method.indexOf("this.clock.pause()") >= 0, "HOLDING must pause the clock");
  assert.ok(method.indexOf("await this.seek(targetTime, { suppressSpinner: true })") >= 0, "HOLDING must seek its barrier target");
  assert.ok(
    method.indexOf("this.clock.pause()") < method.indexOf("await this.seek(targetTime, { suppressSpinner: true })"),
    "clock must stop before asynchronous seek can fetch a keyframe and leak local playback time",
  );
});
