import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedBytes } from "../../web/src/http.ts";

test("map reads preserve bytes and cancel an oversized streaming response", async () => {
  assert.deepEqual(
    await boundedBytes(new Response(new Uint8Array([0, 128, 255])), 3),
    new Uint8Array([0, 128, 255]),
  );
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(() => boundedBytes(response, 8), /size limit/);
  assert.equal(cancelled, true);
});
