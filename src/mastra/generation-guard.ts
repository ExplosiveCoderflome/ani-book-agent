import { AppError } from "../application/errors";
import { clearProductionModelRetry, recordProductionModelRetry } from "../application/production-progress";
import { isTransientModelError, markGenerationGuardSignal, transientModelRetryDelayForError } from "./model-retry";

export const MODEL_GENERATION_TIMEOUT_MS = 120_000;
export const MODEL_GENERATION_MAX_RETRIES = 3;

type RetryOptions = { maxRetries?: number; delayMs?: (error: unknown, retryCount: number) => number; abortSignal?: AbortSignal; progressId?: string };

function abortReason(signal: AbortSignal) { return signal.reason ?? new DOMException("用户已停止本次操作", "AbortError"); }
function wait(delayMs: number, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) return Promise.reject(abortReason(abortSignal));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    function done() { abortSignal?.removeEventListener("abort", stopped); resolve(); }
    function stopped() { clearTimeout(timeout); abortSignal?.removeEventListener("abort", stopped); reject(abortReason(abortSignal!)); }
    abortSignal?.addEventListener("abort", stopped, { once: true });
  });
}

export async function generateWithGuard<T>(label: string, generate: (abortSignal: AbortSignal) => Promise<T>, timeoutMs = MODEL_GENERATION_TIMEOUT_MS, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? MODEL_GENERATION_MAX_RETRIES;
  try {
  for (let retryCount = 0; ; retryCount += 1) {
    if (options.abortSignal?.aborted) throw abortReason(options.abortSignal);
    const controller = new AbortController();
    markGenerationGuardSignal(controller.signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watchdogError: AppError | undefined;
    let stopListening: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          watchdogError = new AppError("MODEL_GENERATION_TIMEOUT", `${label} 超时，未写入任何工件。`, 504, true);
          reject(watchdogError);
          controller.abort(watchdogError);
        }, timeoutMs);
      });
      const parentAbortSignal = options.abortSignal;
      const canceled = parentAbortSignal ? new Promise<never>((_, reject) => {
        const stop = () => { controller.abort(abortReason(parentAbortSignal)); reject(abortReason(parentAbortSignal)); };
        stopListening = () => parentAbortSignal.removeEventListener("abort", stop);
        parentAbortSignal.addEventListener("abort", stop, { once: true });
      }) : undefined;
      const result = await Promise.race([generate(controller.signal), deadline, ...(canceled ? [canceled] : [])]);
      if (result && typeof result === "object" && "tripwire" in result && result.tripwire) {
        const tripwire = result.tripwire as { reason?: string; processorId?: string };
        if (tripwire.processorId === "token-limiter" || tripwire.reason?.includes("TokenLimiterProcessor")) throw new AppError("CONTEXT_LIMIT_EXCEEDED", `${label} 的输入超过模型上下文预算，未写入本次工件。已完成的结果仍会保留，请缩小分析范围后重试。`, 409, true);
        throw new AppError("MODEL_PROCESSOR_REJECTED", `${label} 被输入处理器拦截：${tripwire.reason ?? "请求未通过检查"}`, 409, false);
      }
      return result;
    } catch (caught) {
      // An abort-aware provider can reject synchronously when the watchdog aborts it.
      // Normalize that competing rejection back to the authoritative timeout error.
      const error = watchdogError ?? caught;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("TokenLimiterProcessor")) throw new AppError("CONTEXT_LIMIT_EXCEEDED", `${label} 的输入超过模型上下文预算，未写入任何工件，请缩短上下文后重试。`, 409, true);
      const timeoutError = error instanceof AppError && error.code === "MODEL_GENERATION_TIMEOUT";
      if (retryCount >= maxRetries || (!timeoutError && !isTransientModelError(error))) throw error;
      const delayMs = options.delayMs?.(error, retryCount) ?? transientModelRetryDelayForError(error, retryCount);
      if (options.progressId) recordProductionModelRetry(options.progressId, { label, attempt: retryCount + 1, maxRetries, delayMs });
      await wait(delayMs, options.abortSignal);
    } finally {
      if (timeout) clearTimeout(timeout);
      stopListening?.();
    }
  }
  } finally {
    if (options.progressId) clearProductionModelRetry(options.progressId);
  }
}
