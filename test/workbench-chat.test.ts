import assert from "node:assert/strict";
import test from "node:test";
import { recallChatMessages } from "../src/application/workbench-service";

test("a new novel opens chat with empty history before its Mastra thread exists", async () => {
  let recallCalled = false;
  const memory = {
    getThreadById: async () => null,
    recall: async () => {
      recallCalled = true;
      throw new Error("recall must not run without a thread");
    },
  } as unknown as Parameters<typeof recallChatMessages>[0];

  assert.deepEqual(await recallChatMessages(memory, "new-novel"), []);
  assert.equal(recallCalled, false);
});
