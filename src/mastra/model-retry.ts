import { isRetryableOpenAIResponsesStreamError, StreamErrorRetryProcessor, type ProcessAPIErrorArgs } from "@mastra/core/processors";

export const transientModelRetryDelays = [1_500, 4_000, 10_000] as const;
const generationGuardSignals = new WeakSet<AbortSignal>();

export function markGenerationGuardSignal(signal: AbortSignal) { generationGuardSignals.add(signal); return signal; }
export function isGenerationGuardSignal(signal: AbortSignal | undefined) { return Boolean(signal && generationGuardSignals.has(signal)); }

const transientStatuses = new Set([408, 429]);
const transientCodes = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const transientMessage = /socket hang up|fetch failed|connection reset|network error|temporar(?:y|ily) unavailable|timeout|timed? out/i;
const terminalStatuses = new Set([400, 401, 403, 404]);
const terminalCodes = new Set([
  "ABORT_ERR",
  "CONTEXT_LENGTH_EXCEEDED",
  "INVALID_API_KEY",
  "MODEL_NOT_FOUND",
  "PERMISSION_DENIED",
  "UNAUTHORIZED",
]);
const terminalMessage = /context (?:length|window).*(?:exceed|limit)|invalid api key|model (?:does not exist|not found)|permission denied|unauthori[sz]ed|user (?:aborted|cancelled)|operation was aborted/i;

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    const headers = current && typeof current === "object" ? (current as Record<string, unknown>).responseHeaders : undefined;
    if (headers && typeof headers === "object") {
      const entries = Object.entries(headers as Record<string, unknown>);
      const milliseconds = entries.find(([key]) => key.toLowerCase() === "retry-after-ms")?.[1];
      if (typeof milliseconds === "string" && /^\d+$/.test(milliseconds.trim())) return Math.min(30_000, Number(milliseconds));
      const seconds = entries.find(([key]) => key.toLowerCase() === "retry-after")?.[1];
      if (typeof seconds === "string") {
        const normalized = seconds.trim();
        if (/^\d+$/.test(normalized)) return Math.min(30_000, Number(normalized) * 1_000);
        const deadline = Date.parse(normalized);
        if (Number.isFinite(deadline)) return Math.min(30_000, Math.max(0, deadline - Date.now()));
      }
    }
    current = current && typeof current === "object" ? (current as Record<string, unknown>).cause : undefined;
  }
  return undefined;
}

function matchesTransientModelError(error: unknown, visited: Set<unknown>): boolean {
  if (!error || visited.has(error)) return false;
  visited.add(error);
  const status = numberField(error, "statusCode") ?? numberField(error, "status")
    ?? numberField(error && typeof error === "object" ? (error as Record<string, unknown>).response : undefined, "status");
  if (status !== undefined) return transientStatuses.has(status) || status >= 500 && status <= 599;

  const code = stringField(error, "code")?.toUpperCase();
  if (code && transientCodes.has(code)) return true;

  const message = error instanceof Error ? error.message : stringField(error, "message");
  if (message && transientMessage.test(message)) return true;
  const cause = error instanceof Error ? error.cause : error && typeof error === "object" ? (error as Record<string, unknown>).cause : undefined;
  return matchesTransientModelError(cause, visited);
}

export function isTransientModelError(error: unknown): boolean {
  if (isTerminalModelError(error)) return false;
  return providerMarkedRetryable(error)
    || isRetryableOpenAIResponsesStreamError(error)
    || matchesTransientModelError(error, new Set());
}

export function isTerminalModelError(error: unknown): boolean {
  const status = numberField(error, "statusCode") ?? numberField(error, "status")
    ?? numberField(error && typeof error === "object" ? (error as Record<string, unknown>).response : undefined, "status");
  if (status !== undefined && terminalStatuses.has(status)) return true;
  if (stringField(error, "name") === "AbortError") return true;
  const code = stringField(error, "code")?.toUpperCase();
  if (code && terminalCodes.has(code)) return true;
  const message = error instanceof Error ? error.message : stringField(error, "message");
  return Boolean(message && terminalMessage.test(message));
}

export function transientModelRetryDelay(retryCount: number, random = Math.random): number {
  const base = transientModelRetryDelays[Math.min(Math.max(0, retryCount), transientModelRetryDelays.length - 1)]!;
  return Math.round(base * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
}

export function transientModelRetryDelayForError(error: unknown, retryCount: number, random = Math.random) {
  return Math.max(transientModelRetryDelay(retryCount, random), retryAfterMs(error) ?? 0);
}

function providerMarkedRetryable(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as Record<string, unknown>).isRetryable === true);
}

class ReportingStreamErrorRetryProcessor extends StreamErrorRetryProcessor {
  override async processAPIError(args: ProcessAPIErrorArgs) {
    if (isGenerationGuardSignal(args.abortSignal) || isTerminalModelError(args.error)) return;
    const shouldReport = args.retryCount < 3 && !isTerminalModelError(args.error)
      && (providerMarkedRetryable(args.error) || isRetryableOpenAIResponsesStreamError(args.error) || isTransientModelError(args.error));
    const result = super.processAPIError(args);
    if (shouldReport && args.writer) {
      await args.writer.custom({
        type: "data-model-retry",
        data: { attempt: args.retryCount + 1, maxRetries: 3 },
        transient: true,
      }).catch(() => undefined);
    }
    return result;
  }
}

export function createTransientModelRetryProcessor() {
  return new ReportingStreamErrorRetryProcessor({
    maxRetries: 3,
    maxRetryAfterMs: 30_000,
    retryUnknownErrors: false,
    delayMs: ({ retryCount }) => transientModelRetryDelay(retryCount),
    matchers: [
      { match: isTerminalModelError, maxRetries: 0 },
      { match: providerMarkedRetryable },
      { match: isRetryableOpenAIResponsesStreamError },
      { match: isTransientModelError },
    ],
  });
}
