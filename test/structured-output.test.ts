import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { requireStructuredOutput, structuredOutputOptions } from "../src/mastra/structured-output";

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
