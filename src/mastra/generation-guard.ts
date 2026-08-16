import { AppError } from "../application/errors";

export const MODEL_GENERATION_TIMEOUT_MS = 120_000;

export async function generateWithGuard<T>(label: string, generate: (abortSignal: AbortSignal) => Promise<T>, timeoutMs = MODEL_GENERATION_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new AppError("MODEL_GENERATION_TIMEOUT", `${label} 超时，未写入任何工件，可以缩短上下文后重试。`, 504, true));
      }, timeoutMs);
    });
    return await Promise.race([generate(controller.signal), deadline]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("TokenLimiterProcessor")) throw new AppError("CONTEXT_LIMIT_EXCEEDED", `${label} 的输入超过模型上下文预算，未写入任何工件，请缩短上下文后重试。`, 409, true);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
