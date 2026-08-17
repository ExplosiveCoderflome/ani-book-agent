import assert from "node:assert/strict";
import test from "node:test";
import { errorText } from "../src/web/studio/MessageParts";

test("chat errors hide upstream request details", () => {
  const raw = `APICallError ${JSON.stringify({ requestBodyValues: { tools: ["secret schema"] }, responseHeaders: { trace: "internal" } })}`;
  assert.equal(errorText(raw), "模型服务调用失败，请重试；若持续失败，请检查模型设置。");
  assert.equal(errorText({ error: { message: "参数暂时不可用。" } }), "参数暂时不可用。");
});
