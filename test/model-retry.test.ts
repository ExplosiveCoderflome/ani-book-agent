import assert from "node:assert/strict";
import test from "node:test";
import { createTransientModelRetryProcessor, isTerminalModelError, isTransientModelError, markGenerationGuardSignal, transientModelRetryDelay, transientModelRetryDelayForError } from "../src/mastra/model-retry";

test("瞬时模型错误只匹配限流、服务端和网络故障", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientModelError({ status }), true);
  for (const status of [400, 401, 403, 404, 600]) assert.equal(isTransientModelError({ status }), false);
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN", "ENETUNREACH"]) assert.equal(isTransientModelError({ code }), true);
  assert.equal(isTransientModelError(new Error("socket hang up")), true);
  assert.equal(isTransientModelError(new Error("request failed", { cause: { code: "ECONNRESET" } })), true);
  assert.equal(isTransientModelError({ type: "response.failed", response: { error: { code: "server_error", message: "temporary provider problem" } } }), true);
  assert.equal(isTransientModelError({ isRetryable: true, message: "provider failure" }), true);
  assert.equal(isTransientModelError({ status: 400, type: "response.failed", response: { error: { code: "server_error" } } }), false);
  assert.equal(isTransientModelError({ status: 400, isRetryable: true }), false);
  assert.equal(isTransientModelError(new Error("context length exceeded")), false);
  assert.equal(isTransientModelError({ name: "AbortError", message: "The operation was aborted" }), false);
});

test("配置、权限、上下文与用户停止错误明确终止重试", () => {
  for (const status of [400, 401, 403, 404]) assert.equal(isTerminalModelError({ status, isRetryable: true }), true);
  for (const code of ["INVALID_API_KEY", "MODEL_NOT_FOUND", "CONTEXT_LENGTH_EXCEEDED", "ABORT_ERR"]) assert.equal(isTerminalModelError({ code }), true);
  assert.equal(isTerminalModelError({ name: "AbortError", message: "The operation was aborted" }), true);
  assert.equal(isTerminalModelError({ status: 429 }), false);
});

test("三次模型重试使用带抖动的 1.5/4/10 秒退避", () => {
  assert.deepEqual([0, 1, 2].map((attempt) => transientModelRetryDelay(attempt, () => 0.5)), [1_500, 4_000, 10_000]);
  assert.equal(transientModelRetryDelay(0, () => 0), 1_200);
  assert.equal(transientModelRetryDelay(2, () => 1), 12_000);
  assert.equal(transientModelRetryDelay(99, () => 0.5), 10_000);
});

test("重试处理器只为实际可重试错误发送中文进度事件", async () => {
  const processor = createTransientModelRetryProcessor();
  const chunks: unknown[] = [];
  const controller = new AbortController(); controller.abort();
  const base = { stepNumber: 0, steps: [], state: {}, messages: [], messageList: {}, abortSignal: controller.signal, writer: { custom: async (chunk: unknown) => { chunks.push(chunk); } } } as any;
  assert.deepEqual(await processor.processAPIError({ ...base, error: { status: 503 }, retryCount: 0 }), { retry: true });
  assert.deepEqual(chunks, [{ type: "data-model-retry", data: { attempt: 1, maxRetries: 3 }, transient: true }]);
  assert.deepEqual(await processor.processAPIError({ ...base, error: { type: "response.failed", response: { error: { code: "server_error" } } }, retryCount: 0 }), { retry: true });
  assert.deepEqual(await processor.processAPIError({ ...base, error: { isRetryable: true }, retryCount: 0 }), { retry: true });
  assert.equal(await processor.processAPIError({ ...base, error: { status: 401, isRetryable: true }, retryCount: 0 }), undefined);
  assert.equal(await processor.processAPIError({ ...base, error: { status: 400, type: "response.failed", response: { error: { code: "server_error" } } }, retryCount: 0 }), undefined);
  const guarded = new AbortController(); markGenerationGuardSignal(guarded.signal);
  assert.equal(await processor.processAPIError({ ...base, abortSignal: guarded.signal, error: { status: 503 }, retryCount: 0 }), undefined);
  assert.equal(await processor.processAPIError({ ...base, error: { status: 503 }, retryCount: 3 }), undefined);
  assert.equal(chunks.length, 3);
});

test("Retry-After 等待遵守供应商提示但封顶三十秒", async () => {
  const processor = createTransientModelRetryProcessor();
  const waits: number[] = [];
  const original = globalThis.setTimeout;
  (globalThis as any).setTimeout = (callback: () => void, delay: number) => { waits.push(delay); callback(); return 0; };
  try {
    const result = await processor.processAPIError({ error: { status: 503, responseHeaders: { "retry-after-ms": "60000" } }, retryCount: 0, stepNumber: 0, steps: [], state: {}, messages: [], messageList: {} } as any);
    assert.deepEqual(result, { retry: true });
    assert.deepEqual(waits, [30_000]);
  } finally {
    globalThis.setTimeout = original;
  }
});

test("guard 重试接受标准 Retry-After HTTP-date", () => {
  const retryAt = new Date(Date.now() + 20_000).toUTCString();
  const delay = transientModelRetryDelayForError({ responseHeaders: { "retry-after": retryAt } }, 0, () => 0.5);
  assert.ok(delay >= 18_000 && delay <= 20_000, `unexpected delay: ${delay}`);
});
