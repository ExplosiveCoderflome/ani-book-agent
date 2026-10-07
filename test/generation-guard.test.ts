import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/application/errors";
import { productionModelRetry } from "../src/application/production-progress";
import { generateWithGuard } from "../src/mastra/generation-guard";

test("generation guard converts token limiter failures into recoverable context errors", async () => {
  await assert.rejects(
    () => generateWithGuard("第 2 章生成", async () => { throw new Error("TokenLimiterProcessor: No messages fit"); }),
    (error: unknown) => error instanceof AppError && error.code === "CONTEXT_LIMIT_EXCEEDED" && error.recoverable,
  );
});

test("generation guard reports returned token limiter tripwires before schema validation", async () => {
  let calls = 0;
  await assert.rejects(() => generateWithGuard("聚合 segment-001", async () => {
    calls += 1;
    return { object: undefined, tripwire: { processorId: "token-limiter", reason: "TokenLimiterProcessor: No messages fit" } };
  }), (error: unknown) => error instanceof AppError && error.code === "CONTEXT_LIMIT_EXCEEDED" && /已完成的结果仍会保留/.test(error.message));
  assert.equal(calls, 1);
  await assert.rejects(() => generateWithGuard("生成", async () => ({ tripwire: { processorId: "other", reason: "blocked" } })), (error: unknown) => error instanceof AppError && error.code === "MODEL_PROCESSOR_REJECTED");
});

test("generation guard retries a hung model call three times, then stops", async () => {
  let calls = 0;
  await assert.rejects(
    () => generateWithGuard("第 2 章生成", () => { calls += 1; return new Promise<never>(() => undefined); }, 1, { delayMs: () => 0 }),
    (error: unknown) => error instanceof AppError && error.code === "MODEL_GENERATION_TIMEOUT" && error.recoverable,
  );
  assert.equal(calls, 4);
});

test("generation guard keeps the timeout classification when an abort-aware provider rejects first", async () => {
  let calls = 0;
  await assert.rejects(
    () => generateWithGuard("第 2 章生成", (signal) => {
      calls += 1;
      return new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("provider aborted", "AbortError")), { once: true });
      });
    }, 1, { delayMs: () => 0 }),
    (error: unknown) => error instanceof AppError && error.code === "MODEL_GENERATION_TIMEOUT" && error.recoverable,
  );
  assert.equal(calls, 4);
});

test("generation guard shares one four-attempt budget for transient provider failures", async () => {
  let calls = 0;
  const result = await generateWithGuard("第 2 章生成", async () => {
    calls += 1;
    if (calls < 4) throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    return "ok";
  }, 100, { delayMs: () => 0 });
  assert.equal(result, "ok");
  assert.equal(calls, 4);
});

test("user stop aborts retry backoff without creating another model call", async () => {
  const controller = new AbortController(); let calls = 0;
  const running = generateWithGuard("第 2 章生成", async () => { calls += 1; throw Object.assign(new Error("temporarily unavailable"), { status: 503 }); }, 100, { delayMs: () => 10_000, abortSignal: controller.signal });
  controller.abort(new DOMException("用户停止", "AbortError"));
  await assert.rejects(running, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(calls, 1);
});

test("production generation exposes retry progress only while the logical call is retrying", async () => {
  const controller = new AbortController();
  const jobId = "job-progress";
  const running = generateWithGuard("生成第 2 章", async () => {
    throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
  }, 100, { delayMs: () => 10_000, abortSignal: controller.signal, progressId: jobId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(productionModelRetry(jobId), {
    label: "生成第 2 章", attempt: 1, maxRetries: 3, delayMs: 10_000,
    updatedAt: productionModelRetry(jobId)?.updatedAt,
  });
  controller.abort(new DOMException("用户停止", "AbortError"));
  await assert.rejects(running, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(productionModelRetry(jobId), undefined);
});
