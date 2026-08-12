import assert from "node:assert/strict";
import test from "node:test";
import { promptBlockDefaults, promptPresentation } from "../src/mastra/prompts/prompt-blocks";

test("every prompt has a stable workbench group and order", () => {
  const presentations = promptBlockDefaults.map((item) => promptPresentation(item.id));
  assert.equal(presentations.length, promptBlockDefaults.length);
  assert.ok(presentations.every((item) => item.usage && item.order > 0));
  assert.deepEqual(new Set(presentations.map((item) => item.group)), new Set(["对话引导", "书级策划", "章节生产", "审查修复"]));
});
