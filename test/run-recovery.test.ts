import assert from "node:assert/strict";
import test from "node:test";
import { RunEventHub } from "../src/application/run-events";
import { projectedRunStatus, releasesActiveRun, shouldClearActiveRun } from "../src/application/workbench-service";

test("disconnecting an SSE reader stops heartbeat writes to the closed controller", async () => {
  const hub = new RunEventHub(5);
  const stream = hub.stream("run-1", new AbortController().signal);
  const reader = stream.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  hub.publish("run-1", "run.completed", { status: "canceled" });
});

test("a persisted running snapshot without a local executor is recoverable as interrupted", () => {
  assert.equal(projectedRunStatus("running", true), "running");
  assert.equal(projectedRunStatus("running", false), "failed");
  assert.equal(projectedRunStatus("suspended", false), "awaiting_review");
});

test("terminal failures release the active run while running and suspended work remains active", () => {
  assert.equal(releasesActiveRun("failed"), true);
  assert.equal(releasesActiveRun("committed"), true);
  assert.equal(releasesActiveRun("canceled"), true);
  assert.equal(releasesActiveRun("running"), false);
  assert.equal(releasesActiveRun("awaiting_review"), false);
});

test("a failed run only clears its own active-run marker", () => {
  assert.equal(shouldClearActiveRun("run-1", "run-1"), true);
  assert.equal(shouldClearActiveRun("run-2", "run-1"), false);
  assert.equal(shouldClearActiveRun(undefined, "run-1"), false);
});
