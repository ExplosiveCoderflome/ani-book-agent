import assert from "node:assert/strict";
import test from "node:test";
import { projectedRunStatus, releasesActiveRun, shouldClearActiveRun } from "../src/application/workbench-service";

test("Mastra remains authoritative when a run is read without a local executor", () => {
  assert.equal(projectedRunStatus("running", true), "running");
  assert.equal(projectedRunStatus("running", false), "running");
  assert.equal(projectedRunStatus("suspended", false), "awaiting_review");
});

test("terminal failures release the active run while running and suspended work remains active", () => {
  assert.equal(releasesActiveRun("failed"), false);
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
