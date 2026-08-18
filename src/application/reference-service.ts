import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { referenceAnalysisSchema, referenceJobRequestSchema, referenceJobSchema, type DeconstructionFocus, type DeconstructionMode, type ReferenceJob } from "../domain";
import { estimateDeconstruction, ReferenceRepository } from "../infrastructure/reference-repository";
import { modelSettings, sanitizeProviderError } from "../infrastructure/model-settings";
import { referenceDeconstructionWorkflow, DECONSTRUCTION_PROMPT_VERSION } from "../mastra/workflows/reference-deconstruction-workflow";
import { AppError } from "./errors";

export const referenceRepository = new ReferenceRepository();
const starting = new Set<string>();
function workflowStatus(value: string): ReferenceJob["status"] { return value === "suspended" ? "paused" : value === "success" ? "completed" : value === "failed" ? "failed" : value === "canceled" ? "canceled" : "running"; }

export async function importReference(input: { fileName: string; title?: string; bytes: Buffer; rightsConfirmed: boolean }) { return referenceRepository.import(input); }
export async function listReferences() { return referenceRepository.list(); }
export async function referenceDetail(id: string) { const [state, manifest] = await Promise.all([referenceRepository.get(id), referenceRepository.manifest(id)]); const running = await activeJob(); return { state, manifest, estimate: estimateDeconstruction(manifest, "standard", []), ...(running?.referenceId === id ? { activeJob: running } : {}) }; }
export async function estimateReference(id: string, mode: DeconstructionMode, focuses: DeconstructionFocus[]) { return estimateDeconstruction(await referenceRepository.manifest(id), mode, focuses); }
export async function confirmReferenceManifest(id: string, manifestHash: string) { return referenceRepository.confirmManifest(id, manifestHash); }
export async function deleteReference(id: string) { await activeJob(); await referenceRepository.delete(id); return { deleted: true }; }
export async function referenceSource(id: string, start: number, end: number) { return referenceRepository.sourceSlice(id, start, end); }
export async function referenceAnalysis(id: string, analysisId: string) { const state = await referenceRepository.get(id); const analysis = state.analyses.find((item) => item.id === analysisId); if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到这份拆书结果。", 404, false); return { analysis, report: analysis.reportPath ? await referenceRepository.readAnalysisFile(id, analysisId, analysis.reportPath, 500_000) : undefined, index: await referenceRepository.readAnalysisFile(id, analysisId, "index.yaml", 500_000).then((value) => parse(value)).catch(() => undefined) }; }
export async function referenceSegment(id: string, analysisId: string, segmentId: string) { return { content: await referenceRepository.readAnalysisFile(id, analysisId, `segments/${segmentId}.yaml`, 200_000) }; }
export async function referenceChapter(id: string, analysisId: string, chapterId: string) { return { content: await referenceRepository.readAnalysisFile(id, analysisId, `chapters/${chapterId}.yaml`, 200_000) }; }

async function activeJob() {
  const library = await referenceRepository.libraryState(); if (!library.activeJobId || !library.activeReferenceId) return undefined;
  const job = await referenceJobView(library.activeReferenceId, library.activeJobId).catch(() => undefined);
  if (!job || ["completed", "failed", "canceled"].includes(job.status)) { await referenceRepository.setActive(); return undefined; }
  return job;
}

export async function startReferenceJob(referenceId: string, raw: unknown) {
  const input = referenceJobRequestSchema.parse(raw); if (starting.size || await activeJob()) throw new AppError("REFERENCE_JOB_ACTIVE", "当前已有一本参考书正在拆解。", 409, true);
  starting.add(referenceId);
  try {
    const [state, manifest] = await Promise.all([referenceRepository.get(referenceId), referenceRepository.manifest(referenceId)]); if (!state.manifestConfirmed) throw new AppError("REFERENCE_MANIFEST_UNCONFIRMED", "请先确认章节切分。", 409, true); if (input.manifestHash !== state.manifestHash) throw new AppError("REFERENCE_MANIFEST_STALE", "章节切分已经变化，请重新确认。", 409, true);
    await referenceRepository.propagateStale(referenceId, state.source.sha256, state.manifestHash, DECONSTRUCTION_PROMPT_VERSION);
    const estimate = estimateDeconstruction(manifest, input.mode, input.focuses); if (input.tokenBudget < estimate.inputMin + estimate.outputMin) throw new AppError("REFERENCE_BUDGET_TOO_LOW", `预算至少需要 ${estimate.inputMin + estimate.outputMin} Token。`, 409, true);
    await modelSettings.runtimeSelection("analysis"); const run = await referenceDeconstructionWorkflow.createRun({ resourceId: referenceId }); const analysisId = randomUUID(); const timestamp = new Date().toISOString();
    const analysis = referenceAnalysisSchema.parse({ id: analysisId, mode: input.mode, focuses: input.focuses, status: "running", sourceHash: state.source.sha256, manifestHash: state.manifestHash, promptVersion: DECONSTRUCTION_PROMPT_VERSION, tokenBudget: input.tokenBudget, inputTokens: 0, outputTokens: 0, usageEstimated: false, createdAt: timestamp, updatedAt: timestamp });
    await referenceRepository.updateAnalysis(referenceId, analysis); await referenceRepository.setActive(run.runId, referenceId);
    void run.start({ inputData: { referenceId, jobId: run.runId, analysisId, sourceHash: state.source.sha256, manifestHash: state.manifestHash, mode: input.mode, focuses: input.focuses, tokenBudget: input.tokenBudget, promptVersion: DECONSTRUCTION_PROMPT_VERSION } }).catch(async (error) => { await referenceRepository.updateAnalysis(referenceId, { ...analysis, status: "failed", updatedAt: new Date().toISOString() }).catch(() => undefined); await referenceRepository.setActive().catch(() => undefined); console.warn("拆书任务失败", { runId: run.runId, message: sanitizeProviderError(error) }); });
    return referenceJobSchema.parse({ id: run.runId, referenceId, analysisId, mode: input.mode, focuses: input.focuses, status: "running", stage: "准备批次", completed: 0, total: estimate.calls, tokenBudget: input.tokenBudget, inputTokens: 0, outputTokens: 0, usageEstimated: false, createdAt: timestamp, updatedAt: timestamp });
  } finally { starting.delete(referenceId); }
}

export async function referenceJobView(referenceId: string, jobId: string) {
  const run = await referenceDeconstructionWorkflow.getWorkflowRunById(jobId, { fields: ["steps", "result", "error", "payload"] }); if (!run) throw new AppError("REFERENCE_JOB_NOT_FOUND", "没有找到这个拆书任务。", 404, false);
  const payload = (run.payload ?? {}) as Record<string, any>; if (payload.referenceId && payload.referenceId !== referenceId) throw new AppError("REFERENCE_JOB_MISMATCH", "拆书任务不属于这本参考书。", 400, false);
  const state = await referenceRepository.get(referenceId); const analysis = state.analyses.find((item) => item.id === payload.analysisId); if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到拆书任务的分析记录。", 404, false);
  const [batches, segments, focuses] = await Promise.all([referenceRepository.listAnalysisFiles(referenceId, analysis.id, "batches"), referenceRepository.listAnalysisFiles(referenceId, analysis.id, "segments"), referenceRepository.listAnalysisFiles(referenceId, analysis.id, "focus")]); const manifest = await referenceRepository.manifest(referenceId); const estimated = estimateDeconstruction(manifest, analysis.mode, analysis.focuses);
  const stepNames = Object.keys(run.steps ?? {}); const suspendedEntry = Object.entries(run.steps ?? {}).map(([name, raw]) => [name, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload); const status = workflowStatus(run.status);
  const stage = status === "paused" ? "等待追加预算" : status === "completed" ? "已完成" : stepNames.some((item) => item.includes("finalize")) ? "生成并复核全书报告" : focuses.length ? "深度专项复扫" : segments.length ? "聚合全书结构" : batches.length ? "逐章全量拆解" : "准备批次";
  if ((status === "failed" || status === "canceled") && analysis.status === "running") { await referenceRepository.updateAnalysis(referenceId, { ...analysis, status, updatedAt: new Date().toISOString() }); await referenceRepository.setActive(); }
  const timestamp = new Date().toISOString(); const result = (run.result ?? {}) as Record<string, unknown>;
  return referenceJobSchema.parse({ id: jobId, referenceId, analysisId: analysis.id, mode: analysis.mode, focuses: analysis.focuses, status, stage, completed: batches.length + segments.length + focuses.length, total: estimated.calls, tokenBudget: analysis.tokenBudget, inputTokens: typeof result.inputTokens === "number" ? result.inputTokens : analysis.inputTokens, outputTokens: typeof result.outputTokens === "number" ? result.outputTokens : analysis.outputTokens, usageEstimated: analysis.usageEstimated, resultPath: typeof result.reportPath === "string" ? result.reportPath : analysis.reportPath, error: status === "failed" ? sanitizeProviderError(run.error?.message ?? "拆书任务失败") : undefined, createdAt: typeof run.createdAt === "string" ? run.createdAt : analysis.createdAt, updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : timestamp, ...(suspendedEntry ? { _suspendedStep: suspendedEntry[0] } : {}) } as any);
}

export async function referenceJobAction(referenceId: string, jobId: string, input: { action: "continue" | "add_budget" | "cancel"; additionalTokens?: number }) {
  const current = await referenceJobView(referenceId, jobId); const run = await referenceDeconstructionWorkflow.createRun({ runId: jobId, resourceId: referenceId }); const state = await referenceRepository.get(referenceId); const analysis = state.analyses.find((item) => item.id === current.analysisId)!;
  if (input.action === "cancel") { await run.cancel(); await referenceRepository.updateAnalysis(referenceId, { ...analysis, status: "canceled", updatedAt: new Date().toISOString() }); await referenceRepository.setActive(); return { ...current, status: "canceled" as const }; }
  if (current.status !== "paused") throw new AppError("REFERENCE_JOB_NOT_PAUSED", "当前拆书任务没有暂停。", 409, true);
  if (input.action === "add_budget") { const additional = input.additionalTokens ?? 0; if (!Number.isInteger(additional) || additional <= 0 || analysis.tokenBudget + additional > 50_000_000) throw new AppError("REFERENCE_BUDGET_INVALID", "追加预算必须为正整数，且总预算不超过 50,000,000。", 400, false); await referenceRepository.updateAnalysis(referenceId, { ...analysis, tokenBudget: analysis.tokenBudget + additional, status: "running", updatedAt: new Date().toISOString() }); }
  const stateRun = await referenceDeconstructionWorkflow.getWorkflowRunById(jobId, { fields: ["steps"] }); const suspended = Object.entries(stateRun?.steps ?? {}).map(([name, raw]) => [name, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload); if (!suspended) throw new AppError("REFERENCE_JOB_NOT_PAUSED", "没有找到可恢复的拆书步骤。", 409, true);
  void run.resume({ step: suspended[0], resumeData: { action: "continue" } }).catch((error) => console.warn("恢复拆书任务失败", { jobId, message: sanitizeProviderError(error) })); return { ...current, status: "running" as const, tokenBudget: input.action === "add_budget" ? analysis.tokenBudget + (input.additionalTokens ?? 0) : analysis.tokenBudget, updatedAt: new Date().toISOString() };
}
