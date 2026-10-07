import { readFile } from "node:fs/promises";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { marketRadarSnapshotSchema, marketRadarSummarySchema } from "../../domain";
import type { CreativeAgentPort, MarketRadarStore } from "../../application/ports";
import { generateWithGuard } from "../generation-guard";
import { requireStructuredOutput, structuredOutputOptions } from "../structured-output";

const inputSchema = z.object({ sourceIds: z.array(z.string().min(1)).min(1).max(8).default(["all"]), capturedAt: z.string().datetime().optional() });
const preparedSchema = z.object({ snapshot: marketRadarSnapshotSchema, snapshotCapturedAt: z.string().datetime(), sourceIds: inputSchema.shape.sourceIds });
const modelGenreSchema = z.object({ name: z.string(), observation: z.string(), evidence: z.array(z.string()).default([]) });
const modelFeelCardSchema = z.object({ id: z.string(), label: z.string(), prompt: z.string(), reason: z.string() });
export const marketRadarModelSummarySchema = z.object({ overview: z.string(), genres: z.array(modelGenreSchema), feelCards: z.array(modelFeelCardSchema) });
const marketSummaryMaxOutputTokens = 4_000;
type WorkflowDependencies = { market: MarketRadarStore; marketRadarAgent: CreativeAgentPort };
let workflowDependencies: WorkflowDependencies | undefined;
const dependency = () => { if (!workflowDependencies) throw new Error("市场总结工作流尚未完成组合根绑定"); return workflowDependencies; };
const marketRadar = new Proxy({} as MarketRadarStore, { get: (_target, property) => (...args: unknown[]) => (dependency().market as any)[property](...args) });
const marketRadarAgent = new Proxy({} as CreativeAgentPort, { get: (_target, property) => (...args: unknown[]) => (dependency().marketRadarAgent as any)[property](...args) });
function jsonObject(text: string | undefined) {
  if (!text) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}
const prepare = createStep({ id: "prepare-market-radar-summary", inputSchema, outputSchema: preparedSchema, execute: async ({ inputData }) => {
  const snapshot = await marketRadar.get(inputData.capturedAt);
  if (!snapshot?.items.length) throw new Error("请先更新至少一张公开榜单，再生成题材总结。");
  const sourceIds = inputData.sourceIds.includes("all") ? snapshot.sources.filter((source) => source.status === "succeeded").map((source) => source.id) : inputData.sourceIds;
  if (!sourceIds.length || sourceIds.some((id) => !snapshot.sources.some((source) => source.id === id && source.status === "succeeded"))) throw new Error("请选择本次快照中可用的榜单。");
  return { snapshot, snapshotCapturedAt: snapshot.capturedAt, sourceIds };
} });
async function prompt() {
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), "src", "mastra", "prompts", "market-radar-summary.md");
  return (await readFile(file, "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}
function marketRadarSummaryCandidate(value: unknown, text: string | undefined, snapshotCapturedAt: string, sourceIds: string[]) {
  const direct = marketRadarModelSummarySchema.safeParse(value);
  const fromText = !direct.success ? marketRadarModelSummarySchema.safeParse(jsonObject(text)) : undefined;
  const summary = direct.success ? direct.data : fromText?.success ? fromText.data : undefined;
  if (!summary) return undefined;
  const output = marketRadarSummarySchema.safeParse({ ...summary, schemaVersion: 1, snapshotCapturedAt, sourceIds, generatedAt: new Date().toISOString() });
  return output.success ? output.data : undefined;
}
export function marketRadarSummaryFromModel(value: unknown, text: string | undefined, snapshotCapturedAt: string, sourceIds: string[]) {
  return requireStructuredOutput(marketRadarSummarySchema, marketRadarSummaryCandidate(value, text, snapshotCapturedAt, sourceIds), "市场题材总结");
}
export function marketRadarSummaryContext(snapshot: z.output<typeof marketRadarSnapshotSchema>, sourceIds: string[]) {
  const limit = sourceIds.length > 1 ? 10 : 30;
  return sourceIds.flatMap((sourceId) => {
    const seen = new Set<string>();
    return snapshot.items.filter((item) => item.sourceId === sourceId && !seen.has(item.sourceUrl) && !!seen.add(item.sourceUrl)).slice(0, limit)
      .map(({ rank, title, author, category, heatLabel }) => ({ rank, title, author, category, heatLabel, sourceId }));
  });
}
const summarize = createStep({ id: "summarize-market-radar", inputSchema: preparedSchema, outputSchema: marketRadarSummarySchema, retries: 0, execute: async ({ inputData }) => {
  const items = marketRadarSummaryContext(inputData.snapshot, inputData.sourceIds);
  const request = `${await prompt()}\n\n公开榜单快照（采集于 ${inputData.snapshotCapturedAt}）：\n${JSON.stringify(items)}`;
  const result = await generateWithGuard("市场题材总结", (abortSignal) => marketRadarAgent.generate(request, { abortSignal, ...structuredOutputOptions(marketRadarModelSummarySchema), modelSettings: { maxOutputTokens: marketSummaryMaxOutputTokens } }));
  let output = marketRadarSummaryCandidate(result.object, result.text, inputData.snapshotCapturedAt, inputData.sourceIds);
  if (!output) {
    const repairRequest = `${request}\n\n上一次响应没有通过结构校验。请重新生成，只返回完整 JSON 对象，不使用 Markdown 代码块，不添加解释文字。`;
    const repaired = await generateWithGuard("市场题材总结格式修复", (abortSignal) => marketRadarAgent.generate(repairRequest, { abortSignal, toolChoice: "none", modelSettings: { maxOutputTokens: marketSummaryMaxOutputTokens } }));
    if (repaired.finishReason === "length" && !repaired.text) throw new Error("模型推理已用完本次题材总结的输出预算，请重试或改选数据更少的榜单。");
    output = marketRadarSummaryFromModel(repaired.object, repaired.text, inputData.snapshotCapturedAt, inputData.sourceIds);
  }
  await marketRadar.saveSummary(output);
  return output;
} });
const marketRadarSummaryWorkflow = createWorkflow({ id: "market-radar-summary", description: "依据当前公开榜单快照生成可查看的题材总结和动态感觉卡。", inputSchema, outputSchema: marketRadarSummarySchema }).then(prepare).then(summarize).commit();
export function createMarketRadarSummaryWorkflow(deps: WorkflowDependencies) {
  if (workflowDependencies && workflowDependencies !== deps) throw new Error("市场总结工作流已经绑定");
  workflowDependencies = deps;
  return marketRadarSummaryWorkflow;
}
