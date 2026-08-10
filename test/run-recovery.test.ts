import assert from "node:assert/strict";
import test from "node:test";
import { RunEventHub } from "../src/application/run-events";
import { projectedRunStatus } from "../src/application/workbench-service";

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
