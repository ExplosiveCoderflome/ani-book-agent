import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/application/errors";
import { generateWithGuard } from "../src/mastra/generation-guard";

test("generation guard converts token limiter failures into recoverable context errors", async () => {
  await assert.rejects(
    () => generateWithGuard("第 2 章生成", async () => { throw new Error("TokenLimiterProcessor: No messages fit"); }),
    (error: unknown) => error instanceof AppError && error.code === "CONTEXT_LIMIT_EXCEEDED" && error.recoverable,
  );
});

test("generation guard aborts a hung model call at its deadline", async () => {
  await assert.rejects(
    () => generateWithGuard("第 2 章生成", () => new Promise<never>(() => undefined), 1),
    (error: unknown) => error instanceof AppError && error.code === "MODEL_GENERATION_TIMEOUT" && error.recoverable,
  );
});
