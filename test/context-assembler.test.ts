import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_CONTENT_BUDGET, planContextParts } from "../src/application/context-assembler";

test("context planner keeps every declared dependency within the shared budget", () => {
  const parts = planContextParts([
    { key: "book:novel_brief", content: "b".repeat(50_000) },
    { key: "volume:2:outline", content: "o".repeat(50_000) },
    { key: "chapter:8:continuity_update", content: "c".repeat(50_000) },
    { key: "chapter:9:chapter_plan", content: "p".repeat(50_000) },
  ]);
  assert.equal(parts.length, 4);
  assert.ok(parts.every((part) => part.allocation > 0));
  assert.ok(parts.reduce((sum, part) => sum + part.allocation, 0) <= CONTEXT_CONTENT_BUDGET);
  assert.ok(parts.find((part) => part.key.endsWith(":chapter_plan"))!.allocation > parts.find((part) => part.key === "book:novel_brief")!.allocation);
  assert.equal(parts.find((part) => part.key.endsWith(":continuity_update"))!.tail, true);
  assert.ok(parts.find((part) => part.key === "volume:2:outline")!.allocation > parts.find((part) => part.key === "book:novel_brief")!.allocation);
});
