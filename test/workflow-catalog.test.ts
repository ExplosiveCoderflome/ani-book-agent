import assert from "node:assert/strict";
import test from "node:test";
import { workflowIds } from "../src/domain";
import { workflowCatalog } from "../src/shared/workflow-catalog";

test("every workflow has complete user-facing metadata", () => {
  assert.deepEqual(Object.keys(workflowCatalog), [...workflowIds]);
  assert.equal(new Set(Object.values(workflowCatalog).map((item) => item.description)).size, workflowIds.length);
  for (const id of workflowIds) {
    const item = workflowCatalog[id];
    assert.ok(item.name.length >= 3, `${id} name is too short`);
    assert.ok(item.description.length >= 30, `${id} description is too shallow`);
    assert.ok(item.target.length > 0, `${id} target is missing`);
    assert.ok(item.stages.length > 0, `${id} stages are missing`);
  }
});
