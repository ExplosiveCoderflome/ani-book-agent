import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { requireStructuredOutput, structuredOutputOptions } from "../src/mastra/structured-output";
import { chatChoicesSchema } from "../src/shared/contracts";

const schema = z.object({ title: z.string().min(1) });

test("structured output options disable tools while retaining the schema", () => {
  const options = structuredOutputOptions(schema);
  assert.equal(options.toolChoice, "none");
  assert.equal(options.structuredOutput.schema, schema);
});

test("structured output validation rejects missing and invalid objects without exposing Zod details", () => {
  for (const value of [undefined, { title: "" }]) {
    assert.throws(
      () => requireStructuredOutput(schema, value, "测试提案"),
      (error: unknown) => error instanceof Error
        && error.message === "模型未返回有效的测试提案结构化数据，请检查模型响应格式后重试。"
        && error.cause instanceof z.ZodError,
    );
  }
});

test("structured output validation returns valid data", () => {
  assert.deepEqual(requireStructuredOutput(schema, { title: "有效提案" }, "测试提案"), { title: "有效提案" });
});

test("chat choices accept four complete replies and reject a fifth option", () => {
  const choices = Array.from({ length: 4 }, (_, index) => ({ label: `方向${index + 1}`, description: `阅读体验${index + 1}`, message: `我选择方向${index + 1}，请沿着这个核心体验继续。` }));
  assert.equal(chatChoicesSchema.parse({ choices }).choices.length, 4);
  assert.equal(chatChoicesSchema.safeParse({ choices: [...choices, choices[0]] }).success, false);
});
