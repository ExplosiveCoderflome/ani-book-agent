import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { generateStructuredOutput, isNativeStructuredOutputUnsupported, jsonObject, requireStructuredOutput, structuredOutputOptions } from "../src/mastra/structured-output";

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

test("JSON object extraction accepts fenced and explained provider output", () => {
  assert.deepEqual(jsonObject("说明如下：\n```json\n{\"title\":\"兼容结果\"}\n```"), { title: "兼容结果" });
});

test("structured generation uses one validated JSON-text call", async () => {
  const modes: string[] = [];
  const result = await generateStructuredOutput({
    schema,
    label: "测试提案",
    prompt: "生成测试提案",
    generate: async (prompt, mode) => {
      modes.push(mode);
      assert.match(prompt, /JSON Schema/);
      return { text: "```json\n{\"title\":\"降级成功\"}\n```" };
    },
  });
  assert.deepEqual(result, { title: "降级成功" });
  assert.deepEqual(modes, ["json-text"]);
});

test("structured generation does not hide unrelated provider errors", async () => {
  const providerError = new Error("provider request timed out");
  await assert.rejects(
    generateStructuredOutput({ schema, label: "测试提案", prompt: "生成", generate: async () => { throw providerError; } }),
    (error: unknown) => error === providerError,
  );
  assert.equal(isNativeStructuredOutputUnsupported(providerError), false);
  assert.equal(isNativeStructuredOutputUnsupported(new Error("Structured output validation failed")), false);
  assert.equal(isNativeStructuredOutputUnsupported(new Error("response_format json_schema is unsupported")), true);
});

test("structured generation rejects invalid JSON without a second model call", async () => {
  let calls = 0;
  await assert.rejects(
    generateStructuredOutput({
      schema,
      label: "测试提案",
      prompt: "生成",
      generate: async () => { calls += 1; return { text: "{\"title\":\"\"}" }; },
    }),
    (error: unknown) => error instanceof Error && error.message === "模型未返回有效的测试提案结构化数据，请检查模型响应格式后重试。",
  );
  assert.equal(calls, 1);
});
