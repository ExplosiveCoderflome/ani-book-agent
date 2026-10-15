import { parse } from "yaml";
import { referenceAnalysisPresetSections, referenceAnalysisSchema, referenceJobRequestSchema, referenceJobSchema, type ChapterRange, type DeconstructionFocus, type DeconstructionMode, type ReferenceAnalysisPreset, type ReferenceJob } from "../domain";
import { AppError } from "./errors";
import type { ChapterPatternAdvisorPort, CharacterProfileRunner, ErrorSanitizer, ModelSettingsPort, ReferenceAnalysisRunner, ReferenceEstimatorPort, ReferenceLibraryStore } from "./ports";

export function createReferenceService(deps: {
  references: ReferenceLibraryStore; models: ModelSettingsPort; deconstruction: ReferenceAnalysisRunner; characters: CharacterProfileRunner;
  chapterPattern: ChapterPatternAdvisorPort; estimator: ReferenceEstimatorPort; sanitizeError: ErrorSanitizer; promptVersion: string; newId(): string;
}) {
const referenceRepository = deps.references;
const modelSettings = deps.models;
const referenceDeconstructionWorkflow = deps.deconstruction;
const referenceCharacterProfileWorkflow = deps.characters;
const sanitizeProviderError = deps.sanitizeError;
const DECONSTRUCTION_PROMPT_VERSION = deps.promptVersion;
const estimateDeconstruction = deps.estimator.estimate;
const referenceChaptersInRange = deps.estimator.chapters;
const suggestChapterPattern = (sample: unknown) => deps.chapterPattern.suggest(sample);
const starting = new Set<string>();
function workflowStatus(value: string): ReferenceJob["status"] { return value === "suspended" ? "paused" : value === "success" ? "completed" : value === "failed" ? "failed" : value === "canceled" ? "canceled" : "running"; }
function referenceFailureMessage(error: unknown, stage: string) {
  const message = sanitizeProviderError(error);
  if (/structured output validation failed|invalid input: expected|string, received undefined/i.test(message)) {
    return `${stage}的结构化结果未通过校验。已完成的章节批次仍会保留；重新开始时，系统会自动复用其中兼容的结果。`;
  }
  return message;
}

async function importReference(input: { fileName: string; title?: string; bytes: Buffer }) { return referenceRepository.import(input); }
async function listReferences() { return referenceRepository.list(); }
async function referenceDetail(id: string) { const [state, manifest, parser] = await Promise.all([referenceRepository.get(id), referenceRepository.manifest(id), referenceRepository.parser(id)]); const running = await activeJob(); return { state, manifest, parser, estimate: estimateDeconstruction(manifest, "standard", []), ...(running?.referenceId === id ? { activeJob: running } : {}) }; }
async function estimateReference(id: string, mode: DeconstructionMode, focuses: DeconstructionFocus[], chapterRange?: ChapterRange, preset: ReferenceAnalysisPreset = "standard") { return estimateDeconstruction(await referenceRepository.manifest(id), mode, focuses, chapterRange, preset); }
async function rebuildReferenceManifest(id: string) { const running = await activeJob(); if (running?.referenceId === id) throw new AppError("REFERENCE_ACTIVE", "这本参考书正在拆解，请先取消任务再重新识别章节。", 409, true); return referenceRepository.rebuildManifest(id); }
async function saveReferenceParser(id: string, input: unknown) { const running = await activeJob(); if (running?.referenceId === id) throw new AppError("REFERENCE_ACTIVE", "这本参考书正在拆解，请先取消任务再修改章节规则。", 409, true); await referenceRepository.saveParser(id, input); return referenceRepository.rebuildManifest(id); }
async function suggestReferencePattern(id: string, sample: unknown) { await referenceRepository.get(id); return suggestChapterPattern(sample); }
async function confirmReferenceManifest(id: string, manifestHash: string) { return referenceRepository.confirmManifest(id, manifestHash); }
async function deleteReference(id: string) { await activeJob(); await referenceRepository.delete(id); return { deleted: true }; }
async function referenceSource(id: string, start: number, end: number) { return referenceRepository.sourceSlice(id, start, end); }
async function referenceAnalysis(id: string, analysisId: string) { const state = await referenceRepository.get(id); const analysis = state.analyses.find((item) => item.id === analysisId); if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到这份拆书结果。", 404, false); const [sections, index, radar] = await Promise.all([referenceRepository.sections(id, analysisId), referenceRepository.readAnalysisFile(id, analysisId, "index.yaml", 500_000).then((value) => parse(value)).catch(() => undefined), analysis.radarPath ? referenceRepository.radar(id, analysisId).catch(() => undefined) : undefined]); return { analysis, sections, index, radar }; }
async function referenceSection(id: string, analysisId: string, key: string) { return referenceRepository.section(id, analysisId, key); }
async function referenceCharacter(id: string, analysisId: string, name: string) { return referenceRepository.character(id, analysisId, name); }
async function clearReferenceAnalyses(id: string) { await activeJob(); return { state: await referenceRepository.clearAnalyses(id) }; }
async function startReferenceCharacterProfile(referenceId: string, analysisId: string, name: string) {
  const state = await referenceRepository.get(referenceId); const analysis = state.analyses.find((item) => item.id === analysisId && item.status === "completed");
  if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "只能研究已完成的拆书结果。", 404, true);
  const section = await referenceRepository.section(referenceId, analysisId, "character_system");
  if (!section.characterCandidates.some((item) => item.name === name)) throw new AppError("REFERENCE_CHARACTER_NOT_FOUND", "没有找到这个角色候选。", 404, true);
  const timestamp = new Date().toISOString();
  await referenceRepository.updateAnalysis(referenceId, { ...analysis, characterProfiles: [...analysis.characterProfiles.filter((item) => item.name !== name), { name, status: "generating", updatedAt: timestamp }], updatedAt: timestamp });
  const run = await referenceCharacterProfileWorkflow.createRun({ resourceId: referenceId });
  void run.start({ inputData: { referenceId, analysisId, name } }).catch(async (error) => {
    const fresh = await referenceRepository.get(referenceId); const current = fresh.analyses.find((item) => item.id === analysisId); if (current) await referenceRepository.updateAnalysis(referenceId, { ...current, characterProfiles: [...current.characterProfiles.filter((item) => item.name !== name), { name, status: "failed", updatedAt: new Date().toISOString(), error: sanitizeProviderError(error) }], updatedAt: new Date().toISOString() });
  });
  return { id: run.runId, name, status: "generating" as const };
}
async function referenceSegment(id: string, analysisId: string, segmentId: string) { return { content: await referenceRepository.readAnalysisFile(id, analysisId, `segments/${segmentId}.yaml`, 200_000) }; }
async function referenceChapter(id: string, analysisId: string, chapterId: string) { return { content: await referenceRepository.readAnalysisFile(id, analysisId, `chapters/${chapterId}.yaml`, 200_000) }; }

async function activeJob() {
  const library = await referenceRepository.libraryState(); if (!library.activeJobId || !library.activeReferenceId) return undefined;
  const job = await referenceJobView(library.activeReferenceId, library.activeJobId);
  if (["completed", "failed", "canceled"].includes(job.status)) { await referenceRepository.clearActiveJob(library.activeReferenceId, library.activeJobId); return undefined; }
  return job;
}

async function startReferenceJob(referenceId: string, raw: unknown) {
  const input = referenceJobRequestSchema.parse(raw); if (starting.size) throw new AppError("REFERENCE_JOB_ACTIVE", "当前已有一本参考书正在拆解。", 409, true);
  starting.add(referenceId);
  try {
    if (await activeJob()) throw new AppError("REFERENCE_JOB_ACTIVE", "当前已有一本参考书正在拆解。", 409, true);
    const [state, manifest] = await Promise.all([referenceRepository.get(referenceId), referenceRepository.manifest(referenceId)]); if (!state.manifestConfirmed) throw new AppError("REFERENCE_MANIFEST_UNCONFIRMED", "请先确认章节切分。", 409, true); if (input.manifestHash !== state.manifestHash) throw new AppError("REFERENCE_MANIFEST_STALE", "章节切分已经变化，请重新确认。", 409, true);
    await referenceRepository.propagateStale(referenceId, state.source.sha256, state.manifestHash, DECONSTRUCTION_PROMPT_VERSION);
    const scopedChapters = referenceChaptersInRange(manifest, input.chapterRange); const scopedChars = scopedChapters.reduce((sum, chapter) => sum + chapter.end - chapter.start, 0);
    const estimate = estimateDeconstruction(manifest, "standard", [], input.chapterRange, input.preset); if (input.tokenBudget < estimate.inputMin + estimate.outputMin) throw new AppError("REFERENCE_BUDGET_TOO_LOW", `预算至少需要 ${estimate.inputMin + estimate.outputMin} Token。`, 409, true);
    await modelSettings.runtimeSelection("analysis"); const run = await referenceDeconstructionWorkflow.createRun({ resourceId: referenceId }); const analysisId = deps.newId(); const timestamp = new Date().toISOString();
    const analysis = referenceAnalysisSchema.parse({ id: analysisId, mode: "standard", focuses: [], preset: input.preset, sectionKeys: referenceAnalysisPresetSections[input.preset], chapterRange: input.chapterRange, status: "running", sourceHash: state.source.sha256, manifestHash: state.manifestHash, promptVersion: DECONSTRUCTION_PROMPT_VERSION, tokenBudget: input.tokenBudget, inputTokens: 0, outputTokens: 0, usageEstimated: false, createdAt: timestamp, updatedAt: timestamp });
    await referenceRepository.claimJob(referenceId, run.runId, analysis);
    void run.start({ inputData: { referenceId, jobId: run.runId, analysisId, sourceHash: state.source.sha256, manifestHash: state.manifestHash, mode: "standard", preset: input.preset, focuses: [], chapterRange: input.chapterRange, tokenBudget: input.tokenBudget, promptVersion: DECONSTRUCTION_PROMPT_VERSION } }).catch(async (error) => { await referenceRepository.finishJob(referenceId, run.runId, analysisId, { status: "failed" }).catch(() => undefined); console.warn("拆书任务失败", { runId: run.runId, message: sanitizeProviderError(error) }); });
    const batchesTotal = Math.max(1, Math.ceil(scopedChars / 18_000));
    const segmentsTotal = Math.max(1, Math.ceil(scopedChapters.length / 25));
    const macrosTotal = Math.max(1, Math.ceil(segmentsTotal / 4));
    const focusesTotal = input.mode === "deep" ? batchesTotal * input.focuses.length : 0;
    const phaseTotal = input.mode === "deep" ? 5 : 4;
    return referenceJobSchema.parse({ id: run.runId, referenceId, analysisId, mode: input.mode, focuses: input.focuses, chapterRange: input.chapterRange, status: "running", stage: "准备批次", completed: 0, total: batchesTotal + segmentsTotal + macrosTotal + focusesTotal + 1, tokenBudget: input.tokenBudget, inputTokens: 0, outputTokens: 0, usageEstimated: false, createdAt: timestamp, updatedAt: timestamp, progress: { phaseIndex: 1, phaseTotal, detail: "正在核对原文、章节范围与预算，随后开始逐批读取。", chaptersCovered: 0, chaptersTotal: scopedChapters.length, batchesCompleted: 0, batchesTotal, segmentsCompleted: 0, segmentsTotal, macrosCompleted: 0, macrosTotal, focusesCompleted: 0, focusesTotal, reportCompleted: false } });
  } finally { starting.delete(referenceId); }
}

async function referenceJobView(referenceId: string, jobId: string) {
  const run = await referenceDeconstructionWorkflow.getWorkflowRunById(jobId, { fields: ["steps", "result", "error", "payload"] }); if (!run) throw new AppError("REFERENCE_JOB_NOT_FOUND", "没有找到这个拆书任务。", 404, false);
  const payload = (run.payload ?? {}) as Record<string, any>; if (payload.referenceId && payload.referenceId !== referenceId) throw new AppError("REFERENCE_JOB_MISMATCH", "拆书任务不属于这本参考书。", 400, false);
  const state = await referenceRepository.get(referenceId); const analysis = state.analyses.find((item) => item.id === payload.analysisId); if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到拆书任务的分析记录。", 404, false);
  const [batches, structureFiles, focusFiles, manifest] = await Promise.all([referenceRepository.listAnalysisFiles(referenceId, analysis.id, "batches"), referenceRepository.listAnalysisFiles(referenceId, analysis.id, "segments"), referenceRepository.listAnalysisFiles(referenceId, analysis.id, "focus"), referenceRepository.manifest(referenceId)]);
  const scopedChapters = referenceChaptersInRange(manifest, analysis.chapterRange); const scopedChars = scopedChapters.reduce((sum, chapter) => sum + chapter.end - chapter.start, 0);
  const [batchValues, focusValues] = await Promise.all([
    Promise.all(batches.map((file) => referenceRepository.readAnalysisFile(referenceId, analysis.id, file, 500_000).then((value) => parse(value) as any).catch(() => undefined))),
    Promise.all(focusFiles.map((file) => referenceRepository.readAnalysisFile(referenceId, analysis.id, file, 500_000).then((value) => parse(value) as any).catch(() => undefined))),
  ]);
  const segments = structureFiles.filter((file) => /\/segment-/.test(file));
  const macros = structureFiles.filter((file) => /\/macro-/.test(file));
  const chaptersCovered = new Set(batchValues.flatMap((value) => Array.isArray(value?.chapters) ? value.chapters.map((chapter: any) => chapter.chapterId).filter(Boolean) : [])).size;
  const lastCoveredChapter = [...scopedChapters].reverse().find((chapter) => batchValues.some((value) => value?.chapters?.some((item: any) => item.chapterId === chapter.id)));
  const liveBatchUsage = batchValues.reduce((sum, value) => ({ inputTokens: sum.inputTokens + Number(value?.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + Number(value?.usage?.outputTokens ?? 0), estimated: sum.estimated || Boolean(value?.usage?.estimated) }), { inputTokens: 0, outputTokens: 0, estimated: false });
  const liveFocusUsage = focusValues.reduce((sum, value) => ({ inputTokens: sum.inputTokens + Number(value?.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + Number(value?.usage?.outputTokens ?? 0), estimated: sum.estimated || Boolean(value?.usage?.estimated) }), { inputTokens: 0, outputTokens: 0, estimated: false });
  const estimatedBatches = Math.max(1, Math.ceil(scopedChars / 18_000));
  const plannedCount = (stepId: string) => {
    const raw = run.steps?.[stepId];
    const step = (Array.isArray(raw) ? raw.at(-1) : raw) as { output?: unknown } | undefined;
    return Array.isArray(step?.output) ? step.output.length : undefined;
  };
  const batchesTotal = Math.max(plannedCount("prepare-reference-batches") ?? estimatedBatches, batches.length);
  const segmentsTotal = Math.max(plannedCount("prepare-reference-segments") ?? Math.ceil(scopedChapters.length / 25), segments.length, 1);
  const macrosTotal = Math.max(plannedCount("prepare-reference-macros") ?? Math.ceil(segmentsTotal / 4), macros.length, 1);
  const focusesTotal = analysis.mode === "deep" ? Math.max(batchesTotal * analysis.focuses.length, focusFiles.length) : 0;
  const phaseTotal = analysis.mode === "deep" ? 5 : 4;
  const reportCompleted = Boolean(analysis.reportPath);
  const progressCompleted = batches.length + segments.length + macros.length + focusFiles.length + (reportCompleted ? 1 : 0);
  const progressTotal = batchesTotal + segmentsTotal + macrosTotal + focusesTotal + 1;
  const suspendedEntry = Object.entries(run.steps ?? {}).map(([name, raw]) => [name, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload); const status = workflowStatus(run.status);
  const phaseIndex = status === "completed" ? phaseTotal : batches.length < batchesTotal ? 1 : segments.length < segmentsTotal ? 2 : macros.length < macrosTotal ? 3 : analysis.mode === "deep" && focusFiles.length < focusesTotal ? 4 : phaseTotal;
  const activeStage = phaseIndex === 1 ? (batches.length ? "逐章全量拆解" : "准备批次") : phaseIndex === 2 ? "聚合故事阶段" : phaseIndex === 3 ? "汇总全书结构" : analysis.mode === "deep" && phaseIndex === 4 ? "深度专项复扫" : "生成并复核全书报告";
  const stage = status === "paused" ? "等待追加预算" : status === "completed" ? "已完成" : activeStage;
  const detail = status === "paused" ? `已使用 ${analysis.inputTokens + analysis.outputTokens} Token，追加预算后会从当前阶段继续。` : phaseIndex === 1 ? `${batches.length ? `已完成 ${batches.length} 个原文批次` : "正在准备第一个原文批次"}${lastCoveredChapter ? `，最近覆盖到《${lastCoveredChapter.title}》` : ""}。` : phaseIndex === 2 ? `正在把逐章结果归纳为连续故事阶段，已完成 ${segments.length}/${segmentsTotal} 段。` : phaseIndex === 3 ? `正在合并阶段结果，建立全书层面的升级、因果和人物弧线。` : analysis.mode === "deep" && phaseIndex === 4 ? `正在复扫原文专项，已完成 ${focusFiles.length}/${focusesTotal} 个专项批次。` : "正在生成全书报告，并按原文偏移复核关键证据。";
  if ((status === "failed" || status === "canceled") && analysis.status === "running") await referenceRepository.finishJob(referenceId, jobId, analysis.id, { status });
  const timestamp = new Date().toISOString(); const result = (run.result ?? {}) as Record<string, unknown>;
  const liveInputTokens = analysis.inputTokens > 0 ? analysis.inputTokens + liveFocusUsage.inputTokens : liveBatchUsage.inputTokens + liveFocusUsage.inputTokens;
  const liveOutputTokens = analysis.outputTokens > 0 ? analysis.outputTokens + liveFocusUsage.outputTokens : liveBatchUsage.outputTokens + liveFocusUsage.outputTokens;
  return referenceJobSchema.parse({ id: jobId, referenceId, analysisId: analysis.id, mode: analysis.mode, focuses: analysis.focuses, chapterRange: analysis.chapterRange, status, stage, completed: progressCompleted, total: progressTotal, tokenBudget: analysis.tokenBudget, inputTokens: typeof result.inputTokens === "number" ? result.inputTokens : liveInputTokens, outputTokens: typeof result.outputTokens === "number" ? result.outputTokens : liveOutputTokens, usageEstimated: analysis.usageEstimated || liveBatchUsage.estimated || liveFocusUsage.estimated, resultPath: typeof result.reportPath === "string" ? result.reportPath : analysis.reportPath, error: status === "failed" ? referenceFailureMessage(run.error?.message ?? "拆书任务失败", activeStage) : undefined, createdAt: typeof run.createdAt === "string" ? run.createdAt : analysis.createdAt, updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : timestamp, progress: { phaseIndex, phaseTotal, detail, chaptersCovered: status === "completed" ? scopedChapters.length : chaptersCovered, chaptersTotal: scopedChapters.length, ...(lastCoveredChapter ? { currentChapter: lastCoveredChapter.title } : {}), batchesCompleted: batches.length, batchesTotal, segmentsCompleted: segments.length, segmentsTotal, macrosCompleted: macros.length, macrosTotal, focusesCompleted: focusFiles.length, focusesTotal, reportCompleted }, ...(suspendedEntry ? { _suspendedStep: suspendedEntry[0] } : {}) } as any);
}

async function referenceJobAction(referenceId: string, jobId: string, input: { action: "continue" | "add_budget" | "cancel"; additionalTokens?: number }) {
  const current = await referenceJobView(referenceId, jobId); const run = await referenceDeconstructionWorkflow.createRun({ runId: jobId, resourceId: referenceId }); const state = await referenceRepository.get(referenceId); const analysis = state.analyses.find((item) => item.id === current.analysisId)!;
  if (input.action === "cancel") { await referenceRepository.finishJob(referenceId, jobId, analysis.id, { status: "canceled" }); await run.cancel(); return { ...current, status: "canceled" as const }; }
  if (current.status !== "paused") throw new AppError("REFERENCE_JOB_NOT_PAUSED", "当前拆书任务没有暂停。", 409, true);
  if (input.action === "add_budget") { const additional = input.additionalTokens ?? 0; if (!Number.isInteger(additional) || additional <= 0 || analysis.tokenBudget + additional > 50_000_000) throw new AppError("REFERENCE_BUDGET_INVALID", "追加预算必须为正整数，且总预算不超过 50,000,000。", 400, false); await referenceRepository.updateAnalysis(referenceId, { ...analysis, tokenBudget: analysis.tokenBudget + additional, status: "running", updatedAt: new Date().toISOString() }, jobId); }
  await referenceRepository.assertActiveJob(referenceId, jobId);
  const stateRun = await referenceDeconstructionWorkflow.getWorkflowRunById(jobId, { fields: ["steps"] }); const suspended = Object.entries(stateRun?.steps ?? {}).map(([name, raw]) => [name, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload); if (!suspended) throw new AppError("REFERENCE_JOB_NOT_PAUSED", "没有找到可恢复的拆书步骤。", 409, true);
  void run.resume({ step: suspended[0], resumeData: { action: "continue" } }).catch((error) => console.warn("恢复拆书任务失败", { jobId, message: sanitizeProviderError(error) })); return { ...current, status: "running" as const, tokenBudget: input.action === "add_budget" ? analysis.tokenBudget + (input.additionalTokens ?? 0) : analysis.tokenBudget, updatedAt: new Date().toISOString() };
}

return { importReference, listReferences, referenceDetail, estimateReference, rebuildReferenceManifest, saveReferenceParser, suggestReferencePattern, confirmReferenceManifest, deleteReference, referenceSource, referenceAnalysis, referenceSection, referenceCharacter, clearReferenceAnalyses, startReferenceCharacterProfile, referenceSegment, referenceChapter, startReferenceJob, referenceJobView, referenceJobAction };
}

export type ReferenceService = ReturnType<typeof createReferenceService>;
