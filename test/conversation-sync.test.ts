import assert from "node:assert/strict";
import test from "node:test";
import type { MastraDBMessage } from "@mastra/core/agent";
import { mergeConversationMessages } from "../src/web/Conversation";

const message = (id: string, text: string) => ({ id, role: "assistant", content: { format: 2, parts: [{ type: "text", text }] } }) as MastraDBMessage;

test("refetched chat messages appear without a page reload and do not duplicate live messages", () => {
  const merged = mergeConversationMessages([message("old", "旧消息"), message("new", "已保存的新回复")], [message("old", "旧消息"), message("live", "流式回复")]);
  assert.deepEqual(merged.map((item) => item.id), ["old", "new", "live"]);
  assert.equal(merged.filter((item) => item.id === "old").length, 1);
});
