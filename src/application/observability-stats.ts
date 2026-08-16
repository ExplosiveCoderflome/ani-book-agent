import { mastraStorage } from "../mastra/runtime-storage";

type AnySpan = {
  traceId?: string;
  name?: string;
  spanType?: string;
  status?: "success" | "error" | "running";
  startedAt?: Date | string;
  endedAt?: Date | string | null;
  error?: unknown;
  resourceId?: string | null;
  threadId?: string | null;
  requestContext?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  attributes?: Record<string, unknown> | null;
};

const asDate = (value: Date | string | null | undefined) => value ? new Date(value) : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const attr = (span: AnySpan, key: string) => span.attributes && typeof span.attributes[key] === "object" && span.attributes[key] !== null ? span.attributes[key] as Record<string, unknown> : undefined;

function usage(span: AnySpan) {
  const value = attr(span, "usage") ?? attr(span, "internalUsage");
  return { inputTokens: number(value?.inputTokens), outputTokens: number(value?.outputTokens) };
}

export async function readObservabilityStats(novelId?: string) {
  const observability = await mastraStorage.getStore("observability");
  if (!observability) throw new Error("Observability Storage 尚未就绪。");
  const result = await observability.listTraces({ mode: "page", pagination: { page: 0, perPage: 100 }, orderBy: { field: "startedAt", direction: "DESC" } } as any);
  const roots = ((result.spans ?? []) as AnySpan[]).filter((span) => !novelId || span.resourceId === novelId || span.threadId === novelId || span.requestContext?.novelId === novelId || span.metadata?.novelId === novelId);
  const traces = await Promise.all(roots.slice(0, 50).map(async (root) => {
    if (!root.traceId) return { root, spans: [root] };
    try {
      const trace = await observability.getTrace({ traceId: root.traceId } as any);
      return { root, spans: ((trace as any)?.spans ?? [root]) as AnySpan[] };
    } catch { return { root, spans: [root] }; }
  }));
  const allSpans = traces.flatMap((trace) => trace.spans);
  const counts = { total: roots.length, success: 0, error: 0, running: 0 };
  let durationTotal = 0; let durationCount = 0; let inputTokens = 0; let outputTokens = 0;
  const spanCounts = new Map<string, number>(); const toolCounts = new Map<string, { count: number; errors: number }>();
  for (const root of roots) {
    const status = root.status ?? (root.error ? "error" : root.endedAt ? "success" : "running");
    counts[status] += 1;
    const started = asDate(root.startedAt); const ended = asDate(root.endedAt);
    if (started && ended) { durationTotal += Math.max(0, ended.getTime() - started.getTime()); durationCount += 1; }
  }
  for (const span of allSpans) {
    if (span.spanType) spanCounts.set(span.spanType, (spanCounts.get(span.spanType) ?? 0) + 1);
    if (span.spanType === "model_generation") { const tokens = usage(span); inputTokens += tokens.inputTokens; outputTokens += tokens.outputTokens; }
    if (span.spanType?.toLowerCase().includes("tool")) {
      const name = span.name ?? "未命名工具"; const entry = toolCounts.get(name) ?? { count: 0, errors: 0 }; entry.count += 1; if (span.error) entry.errors += 1; toolCounts.set(name, entry);
    }
  }
  if (!inputTokens && !outputTokens) for (const root of roots) { const tokens = usage(root); inputTokens += tokens.inputTokens; outputTokens += tokens.outputTokens; }
  return {
    generatedAt: new Date().toISOString(),
    scope: novelId ? "novel" : "all",
    totals: { ...counts, averageDurationMs: durationCount ? Math.round(durationTotal / durationCount) : 0, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    spans: [...spanCounts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    tools: [...toolCounts.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.count - a.count).slice(0, 12),
    recent: roots.slice(0, 20).map((root) => { const started = asDate(root.startedAt); const ended = asDate(root.endedAt); return { traceId: root.traceId ?? "", name: root.name ?? "未命名运行", spanType: root.spanType ?? "unknown", status: root.status ?? (root.error ? "error" : root.endedAt ? "success" : "running"), startedAt: started?.toISOString() ?? "", durationMs: started && ended ? Math.max(0, ended.getTime() - started.getTime()) : undefined, error: root.error ? "运行失败" : undefined }; }),
  };
}
