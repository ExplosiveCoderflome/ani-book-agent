import { createHash, randomUUID } from "node:crypto";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { artifactKey, completionAuditKey, decideNextAction, isMultiVolumeProduction, volumeHandoffKey, volumeOutlineKey, workflowIds, type NextAction, type WorkflowId } from "../domain";
import { modelSettings, sanitizeProviderError } from "../infrastructure/model-settings";
import { NovelRepository, novelInputHash, renderNovelBrief } from "../infrastructure/novel-repository";
import { ProductionReceiptStore } from "../infrastructure/production-receipt-store";
import { loadProviderCatalog } from "../infrastructure/provider-catalog";
import { recordTokenUsage } from "../infrastructure/token-usage";
import { artifactProposalSchema, novelBriefSchema, openingPresetProposalSchema, type ArtifactProposal, type OpeningPresetProposal, type RunView } from "../shared/contracts";
import { workflowCatalog } from "../shared/workflow-catalog";
import { effectiveNovelProductionAgent, novelProductionAgent } from "../mastra/agents/novel-production-agent";
import { renderOpeningPresetPrompt } from "../mastra/prompts/opening-preset";
import { ensureDefaultPromptBlocks, promptBlockDefaults, resolvePromptBlock } from "../mastra/prompts/prompt-blocks";
import { artifactWorkflows } from "../mastra/workflows/artifact-workflows";
import { chapterProductionWorkflow, chapterRangeWorkflow, novelExportWorkflow } from "../mastra/workflows/chapter-workflows";
import { autoDirectorWorkflow } from "../mastra/workflows/auto-director-workflow";
import { requireStructuredOutput, structuredOutputOptions } from "../mastra/structured-output";
import { AppError } from "./errors";
import { assembleAvailableNovelContext, assembleNovelContext } from "./context-assembler";
import { buildWorkspaceProjection } from "./workspace-projection";
import { builtinAgentProfiles, builtinSkills, builtinTools, defaultProjectRecipe } from "./platform-catalog";

export const novelRepository = new NovelRepository();

const workflows: Record<WorkflowId, any> = {
  "novel-brief": artifactWorkflows.novelBriefWorkflow,
  "story-bible": artifactWorkflows.storyBibleWorkflow,
  "world-bible": artifactWorkflows.worldBibleWorkflow,
  "character-cast": artifactWorkflows.characterCastWorkflow,
  "volume-strategy": artifactWorkflows.volumeStrategyWorkflow,
  "volume-outline": artifactWorkflows.volumeOutlineWorkflow,
  "volume-handoff": artifactWorkflows.volumeHandoffWorkflow,
  "completion-audit": artifactWorkflows.completionAuditWorkflow,
  "chapter-planning": artifactWorkflows.chapterPlanningWorkflow,
  "quality-repair": artifactWorkflows.qualityRepairWorkflow,
  "chapter-production": chapterProductionWorkflow,
  "chapter-range": chapterRangeWorkflow,
  "novel-export": novelExportWorkflow,
  "auto-director": autoDirectorWorkflow,
};

export const productionReceiptStore = new ProductionReceiptStore();

const definitions: Record<Exclude<WorkflowId, "chapter-production" | "chapter-range" | "novel-export" | "auto-director">, {
  artifactKey: (target?: string) => string; path: (target?: string) => string; title: string; promptId: string; profile: "planning" | "drafting" | "review"; dependsOn: (target?: string) => string[]; milestone: boolean;
}> = {
  "novel-brief": { artifactKey: () => "book:novel_brief", path: () => "book/novel-brief.md", title: "小说简报", promptId: "novel.brief@v2", profile: "planning", dependsOn: () => [], milestone: true },
  "story-bible": { artifactKey: () => "book:story_bible", path: () => "story-bible.md", title: "故事圣经", promptId: "novel.story_bible@v2", profile: "planning", dependsOn: () => ["book:novel_brief"], milestone: true },
  "world-bible": { artifactKey: () => "book:world_bible", path: () => "world-bible.md", title: "世界圣经", promptId: "novel.world_bible@v2", profile: "planning", dependsOn: () => ["book:novel_brief", "book:story_bible"], milestone: false },
  "character-cast": { artifactKey: () => "book:character_cast", path: () => "characters/character-roster.md", title: "角色阵容", promptId: "novel.character_cast@v2", profile: "planning", dependsOn: () => ["book:novel_brief", "book:story_bible", "book:world_bible"], milestone: false },
  "volume-strategy": { artifactKey: () => "book:volume_strategy", path: () => "volumes/volume-strategy.md", title: "卷战略", promptId: "novel.volume_strategy@v2", profile: "planning", dependsOn: () => ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast"], milestone: true },
  "volume-outline": { artifactKey: (target) => volumeOutlineKey(Number(target ?? "1")), path: (target) => `volumes/volume-${String(Number(target ?? "1")).padStart(2, "0")}.md`, title: "当前卷骨架与节奏板", promptId: "novel.volume_outline@v2", profile: "planning", dependsOn: () => ["book:volume_strategy"], milestone: false },
  "volume-handoff": { artifactKey: (target) => volumeHandoffKey(Number(target ?? "1")), path: (target) => `volumes/volume-${String(Number(target ?? "1")).padStart(2, "0")}-handoff.md`, title: "卷间承接包", promptId: "novel.volume_handoff@v2", profile: "planning", dependsOn: () => [], milestone: false },
  "completion-audit": { artifactKey: () => completionAuditKey(), path: () => "production/completion-audit.md", title: "完本验收报告", promptId: "novel.completion_audit@v2", profile: "review", dependsOn: () => [], milestone: false },
  "chapter-planning": { artifactKey: (target) => `chapter:${chapterNumber(target)}:chapter_plan`, path: (target) => `chapters/chapter-${String(chapterNumber(target)).padStart(3, "0")}/plan.md`, title: "章节计划", promptId: "novel.chapter_plan@v2", profile: "planning", dependsOn: (target) => ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast", "book:volume_strategy", "book:volume_outline", ...(chapterNumber(target) > 1 ? [`chapter:${chapterNumber(target) - 1}:continuity_update`, `chapter:${chapterNumber(target) - 1}:humanization_revision`] : [])], milestone: false },
  "quality-repair": { artifactKey: (target) => `chapter:${chapterNumber(target)}:quality_repair`, path: (target) => `chapters/chapter-${String(chapterNumber(target)).padStart(3, "0")}/repair-proposal.md`, title: "质量修复提案", promptId: "novel.chapter_repair@v2", profile: "review", dependsOn: (target) => [`chapter:${chapterNumber(target)}:chapter_plan`, `chapter:${chapterNumber(target)}:humanization_revision`, `chapter:${chapterNumber(target)}:chapter_review`, `chapter:${chapterNumber(target)}:quality_debt`], milestone: false },
};

function chapterNumber(target?: string) {
  const value = Number(target);
  if (!Number.isInteger(value) || value < 1) throw new AppError("INVALID_CHAPTER", "请提供有效章节号。", 400, true);
  return value;
}

function volumeOutlineDependency(state: Awaited<ReturnType<NovelRepository["get"]>>) {
  return isMultiVolumeProduction(state) ? volumeOutlineKey(state.currentVolume) : "book:volume_outline";
}

function volumeHandoffDependencies(volume: number, state: Awaited<ReturnType<NovelRepository["get"]>>) {
  const end = state.volumes[String(volume)]?.endChapter ?? state.currentChapter - 1;
  return [volumeOutlineKey(volume), `chapter:${end}:chapter_plan`, `chapter:${end}:humanization_revision`, `chapter:${end}:chapter_review`, `chapter:${end}:continuity_update`];
}

function completionAuditDependencies(volume: number, state: Awaited<ReturnType<NovelRepository["get"]>>) {
  const end = state.volumes[String(volume)]?.endChapter ?? state.continuity?.lastCommittedChapter ?? 0;
  const keys = ["book:novel_brief", "book:story_bible", "book:volume_strategy", volumeOutlineKey(volume)];
  const start = state.volumes[String(volume)]?.startChapter ?? 1;
  for (let chapter = start; chapter <= end; chapter += 1) keys.push(`chapter:${chapter}:humanization_revision`, `chapter:${chapter}:chapter_review`, `chapter:${chapter}:continuity_update`, `chapter:${chapter}:quality_debt`, `chapter:${chapter}:quality_repair`);
  return keys;
}

export function statusOf(value: string): RunView["status"] {
  return value === "suspended" ? "awaiting_review" : value === "success" ? "committed" : value === "failed" ? "failed" : value === "canceled" ? "canceled" : "running";
}

export function projectedRunStatus(value: string, hasLocalExecutor: boolean): RunView["status"] {
  void hasLocalExecutor;
  return statusOf(value);
}

export function releasesActiveRun(status: RunView["status"]) { return status === "committed" || status === "canceled"; }
export function shouldClearActiveRun(activeRunId: string | undefined, runId: string) { return activeRunId === runId; }

async function clearActiveRun(novelId: string, runId: string) {
  const state = await novelRepository.get(novelId);
  if (shouldClearActiveRun(state.activeRunId, runId)) await novelRepository.setActiveRun(novelId, undefined);
}

async function locateWorkflowRun(runId: string) {
  for (const workflowId of workflowIds) {
    const state = await workflows[workflowId].getWorkflowRunById(runId, { fields: ["steps", "result", "error", "payload"] }).catch(() => null);
    if (state) return { workflowId, workflow: workflows[workflowId], state };
  }
  throw new AppError("RUN_NOT_FOUND", "没有找到这次运行。", 404, false);
}

function workflowDetails(runId: string, workflowId: WorkflowId, state: any, hasLocalExecutor: boolean): RunView {
  const steps = Object.entries(state.steps ?? {}) as Array<[string, any]>;
  const suspended = steps.map(([id, raw]) => [id, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload);
  const envelope = suspended?.[1]?.suspendPayload as Record<string, unknown> | undefined;
  const artifactProposal = artifactProposalSchema.safeParse(envelope?.proposal);
  const legacyProposal = novelBriefSchema.safeParse(envelope?.brief);
  const payload = state.payload as Record<string, unknown> | undefined;
  const result = state.result as Record<string, unknown> | undefined;
  const status = projectedRunStatus(state.status, hasLocalExecutor);
  const executionStatus = status === "awaiting_review" ? "suspended" : status === "committed" ? "succeeded" : status;
  return {
    runId, novelId: state.resourceId ?? String(payload?.novelId ?? ""), workflowId,
    ...(typeof payload?.target === "string" ? { target: payload.target } : {}),
    status, executionStatus, attempt: 1, recovered: false, currentStep: suspended?.[0] ?? steps.at(-1)?.[0],
    ...(workflowId === "novel-brief" && artifactProposal.success && novelBriefSchema.safeParse(artifactProposal.data.metadata.structured).success
      ? { proposal: novelBriefSchema.parse(artifactProposal.data.metadata.structured), artifactProposal: artifactProposal.data }
      : artifactProposal.success ? { artifactProposal: artifactProposal.data } : legacyProposal.success ? { proposal: legacyProposal.data } : {}),
    ...(typeof result?.sha256 === "string" ? { artifactSha256: result.sha256 } : {}),
    ...(typeof result?.path === "string" ? { exportPath: result.path } : {}),
    ...(typeof result?.chapterCount === "number" ? { chapterCount: result.chapterCount } : {}),
    ...(status === "failed" ? { error: state.status === "running" ? { code: "RUN_INTERRUPTED", message: "服务重启时运行尚未结束；权威工件没有被覆盖，可以重新生成。", recoverable: true } : { code: "RUN_FAILED", message: sanitizeProviderError(state.error?.message ?? "运行失败"), recoverable: true } } : {}),
  };
}

export async function runView(runId: string): Promise<RunView> {
  const located = await locateWorkflowRun(runId);
  return workflowDetails(runId, located.workflowId, located.state, false);
}

async function synchronizeRun(runId: string, state: any) {
  const view = await runView(runId).catch(() => undefined);
  if (view && releasesActiveRun(view.status)) await clearActiveRun(view.novelId, runId).catch(() => undefined);
}

function hashInput(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function prepareWorkflowInput(novelId: string, workflowId: WorkflowId, target?: string, extra: Record<string, unknown> = {}) {
  const state = await novelRepository.get(novelId);
  let inputData: Record<string, unknown>;
  let resolvedTarget = target;
  if (workflowId === "auto-director") throw new AppError("USE_AUTO_DIRECTOR_API", "请使用自动导演接口。", 400, false);
  if (workflowId === "chapter-production") {
    const chapter = chapterNumber(target ?? String(state.currentChapter));
    if (chapter !== state.currentChapter || chapter > state.approvedChapterEnd) throw new AppError("CHAPTER_NOT_APPROVED", "该章节尚未获得生产授权。", 409, true);
    const handoff = isMultiVolumeProduction(state) && state.volumes[String(state.currentVolume)]?.startChapter === chapter && state.currentVolume > 1 ? volumeHandoffKey(state.currentVolume - 1) : undefined;
    const dependsOn = definitions["chapter-planning"].dependsOn(String(chapter)).map((key) => key === "book:volume_outline" ? volumeOutlineDependency(state) : key).concat(handoff ? [handoff] : [], `chapter:${chapter}:chapter_plan`);
    inputData = { novelId, chapter, context: await assembleNovelContext(novelRepository, novelId, dependsOn), inputHash: novelInputHash(state, dependsOn), dependsOn };
  } else if (workflowId === "novel-export") inputData = { novelId, fileName: target };
  else if (workflowId === "chapter-range") throw new AppError("USE_CHAPTER_RANGE_API", "请使用章节范围接口。", 400, false);
  else {
    const definition = definitions[workflowId];
    resolvedTarget = workflowId === "volume-outline" ? String(state.currentVolume) : workflowId === "volume-handoff" ? String(state.currentVolume - 1) : workflowId === "completion-audit" ? String(state.currentVolume) : target;
    if (workflowId === "volume-handoff") {
      const volume = state.volumes[String(Number(resolvedTarget))];
      if (!volume || volume.status !== "completed" || volume.final || state.currentVolume !== Number(resolvedTarget) + 1) throw new AppError("VOLUME_HANDOFF_NOT_DUE", "当前还没有进入该卷的卷间承接阶段。", 409, true);
    }
    if (workflowId === "completion-audit") {
      const volume = state.volumes[String(state.currentVolume)];
      if (state.productionStatus !== "awaiting_completion_review" || !volume?.final || volume.status !== "completed") throw new AppError("COMPLETION_AUDIT_NOT_DUE", "当前还没有进入最终卷完本验收阶段。", 409, true);
    }
    if (workflowId === "volume-outline" && isMultiVolumeProduction(state)) {
      const volume = state.volumes[String(state.currentVolume)];
      if (!volume || volume.status !== "active") throw new AppError("VOLUME_NOT_CONFIGURED", "请先确定当前卷的章节范围。", 409, true);
      if (state.currentVolume > 1 && state.artifacts[volumeHandoffKey(state.currentVolume - 1)]?.status !== "ready") throw new AppError("VOLUME_HANDOFF_REQUIRED", "请先完成上一卷的卷间承接包。", 409, true);
    }
    const rawDependencies = workflowId === "volume-handoff" ? volumeHandoffDependencies(Number(resolvedTarget), state)
      : workflowId === "completion-audit" ? completionAuditDependencies(Number(resolvedTarget), state)
        : workflowId === "volume-outline" && isMultiVolumeProduction(state) && state.currentVolume > 1 ? [...definition.dependsOn(resolvedTarget), volumeHandoffKey(state.currentVolume - 1)] : definition.dependsOn(resolvedTarget);
    const dependsOn = rawDependencies.map((key) => key === "book:volume_outline" ? volumeOutlineDependency(state) : key);
    const context = workflowId === "volume-handoff" || workflowId === "completion-audit" ? await assembleAvailableNovelContext(novelRepository, novelId, dependsOn) : await assembleNovelContext(novelRepository, novelId, dependsOn);
    inputData = { novelId, workflowId, target: resolvedTarget, artifactKey: definition.artifactKey(resolvedTarget), artifactPath: definition.path(resolvedTarget), title: definition.title, context, inputHash: novelInputHash(state, dependsOn), promptId: definition.promptId, promptVersion: definition.promptId, modelProfile: definition.profile, dependsOn, requiresReview: definition.milestone && (state.approvalMode ?? "milestone_approval") === "milestone_approval", ...extra };
  }
  return { inputData, inputHash: hashInput(inputData), target: resolvedTarget };
}

async function prepareRangeInput(novelId: string, requestedStart: number, end: number) {
  const state = await novelRepository.get(novelId);
  const start = requestedStart;
  if (start > end) return { complete: true as const };
  if (start !== state.currentChapter) throw new AppError("CHAPTER_RANGE_STALE", `当前应从第 ${state.currentChapter} 章开始。`, 409, true);
  return { complete: false as const, inputData: { novelId, start, end } };
}

async function prepareAutoDirectorInput(novelId: string, startChapter: number, endChapter: number, autoApproveMilestones: boolean) {
  const state = await novelRepository.get(novelId);
  if (startChapter > endChapter) return { complete: true as const };
  if (startChapter !== state.currentChapter) throw new AppError("CHAPTER_RANGE_STALE", `当前应从第 ${state.currentChapter} 章开始。`, 409, true);
  const volume = isMultiVolumeProduction(state) ? state.volumes[String(state.currentVolume)] : undefined;
  if (isMultiVolumeProduction(state) && (!volume || volume.status !== "active")) throw new AppError("VOLUME_NOT_CONFIGURED", "请先确定当前卷的章节范围。", 409, true);
  if (isMultiVolumeProduction(state) && state.currentVolume > 1 && state.artifacts[volumeHandoffKey(state.currentVolume - 1)]?.status !== "ready") throw new AppError("VOLUME_HANDOFF_REQUIRED", "请先完成上一卷的卷间承接包。", 409, true);
  if (volume && endChapter > volume.endChapter) throw new AppError("VOLUME_RANGE_EXCEEDED", `自动导演不能超过第 ${state.currentVolume} 卷的结束章节 ${volume.endChapter}。`, 409, true);
  return { complete: false as const, inputData: { novelId, startChapter, endChapter, autoApproveMilestones } };
}

let productionRuntimeReady: Promise<void> | undefined;
const startingNovels = new Set<string>();

async function reconcileActiveRuns() {
  for (const summary of await novelRepository.list()) {
    const state = await novelRepository.get(summary.id);
    if (!state.activeRunId) continue;
    const view = await runView(state.activeRunId).catch(() => undefined);
    if (!view || view.status === "committed" || view.status === "canceled") {
      await novelRepository.setActiveRun(state.novelId, undefined);
      continue;
    }
    if (view.status === "running" && view.workflowId) {
      const located = await locateWorkflowRun(view.runId);
      const run = await located.workflow.createRun({ runId: view.runId, resourceId: state.novelId });
      void observeOperation(view.runId, { workflowId: located.workflowId, novelId: state.novelId, target: view.target }, run.restart());
    }
  }
}

async function ensureProductionRuntime() {
  productionRuntimeReady ??= reconcileActiveRuns();
  await productionRuntimeReady;
}

async function ensureNoActiveRun(state: Awaited<ReturnType<NovelRepository["get"]>>) {
  if (!state.activeRunId) return;
  const active = await runView(state.activeRunId).catch(() => undefined);
  if (active?.status === "running" || active?.status === "awaiting_review") throw new AppError("RUN_ALREADY_ACTIVE", "这部作品已有运行中的任务。", 409, true);
  await novelRepository.setActiveRun(state.novelId, undefined);
}

async function observeOperation(runId: string, started: { workflowId: WorkflowId; novelId: string; target?: string }, operation: Promise<unknown>) {
  try {
    const view = await operation.then((state) => synchronizeRun(runId, state).then(() => runView(runId).catch(() => undefined)));
    if (started?.workflowId === "chapter-planning" && view?.status === "committed" && started.target) {
      const next = await prepareWorkflowInput(started.novelId, "chapter-production", started.target);
      void startMastraRun({ novelId: started.novelId, workflowId: "chapter-production", target: next.target, inputData: next.inputData, inputHash: next.inputHash }).catch((error) => console.warn("章节生产自动衔接失败", sanitizeProviderError(error)));
    }
  } catch (error) {
    console.warn("Workflow 运行失败", { runId, message: sanitizeProviderError(error) });
  }
}

async function startMastraRun(input: { novelId: string; workflowId: WorkflowId; target?: string; inputData: Record<string, unknown>; inputHash: string }): Promise<RunView> {
  if (startingNovels.has(input.novelId)) throw new AppError("RUN_ALREADY_ACTIVE", "这部作品已有运行中的任务。", 409, true);
  startingNovels.add(input.novelId);
  try {
    await ensureNoActiveRun(await novelRepository.get(input.novelId));
    const run = await workflows[input.workflowId].createRun({ resourceId: input.novelId });
    const idempotencyKey = `${input.novelId}:${input.workflowId}:${input.target ?? ""}:${input.inputHash}:${randomUUID()}`;
    productionReceiptStore.record({ idempotencyKey, novelId: input.novelId, workflowRunId: run.runId, createdAt: new Date().toISOString() });
    await novelRepository.setActiveRun(input.novelId, run.runId);
    void observeOperation(run.runId, input, run.start({ inputData: input.inputData }));
    return { runId: run.runId, novelId: input.novelId, workflowId: input.workflowId, target: input.target, status: "running", executionStatus: "running", attempt: 1, recovered: false };
  } finally {
    startingNovels.delete(input.novelId);
  }
}

export async function startWorkflowRun(novelId: string, workflowId: WorkflowId, target?: string, extra: Record<string, unknown> = {}): Promise<RunView> {
  await Promise.all([ensureDefaultPromptBlocks(), ensureProductionRuntime()]);
  const prepared = await prepareWorkflowInput(novelId, workflowId, target, extra);
  return startMastraRun({ novelId, workflowId, target: prepared.target, inputData: prepared.inputData, inputHash: prepared.inputHash });
}

export function currentActionRunRequest(next: NextAction): { workflowId: WorkflowId; target?: string } {
  if ((next.type !== "produce_artifact" && next.type !== "refresh_artifact") || !next.workflowId) {
    throw new AppError("NEXT_ACTION_REQUIRES_AUTHOR_INPUT", "当前下一步还需要作者确认开书预设、配置卷范围或批准章节范围，不能直接从对话启动。", 409, true);
  }
  if (next.workflowId === "auto-director" || next.workflowId === "chapter-range" || next.workflowId === "novel-export") {
    throw new AppError("NEXT_ACTION_NOT_CHAT_STARTABLE", "当前步骤需要专用的作者配置，不能从对话直接启动。", 409, true);
  }
  return { workflowId: next.workflowId, target: next.artifactKey.startsWith("chapter:") ? next.artifactKey.split(":")[1] : undefined };
}

export async function startCurrentNextAction(novelId: string): Promise<RunView> {
  const next = decideNextAction(await novelRepository.get(novelId));
  const request = currentActionRunRequest(next);
  return startWorkflowRun(novelId, request.workflowId, request.target);
}

export async function startAutoDirector(novelId: string, input: { startChapter?: number; endChapter: number; autoApproveMilestones?: boolean }) {
  await ensureProductionRuntime();
  const state = await novelRepository.get(novelId);
  const startChapter = input.startChapter ?? state.currentChapter;
  if (input.endChapter < startChapter || input.endChapter - startChapter > 99) throw new AppError("INVALID_CHAPTER_RANGE", "自动导演章节范围必须连续且最多 100 章。", 400, true);
  const autoApproveMilestones = input.autoApproveMilestones ?? false;
  const prepared = await prepareAutoDirectorInput(novelId, startChapter, input.endChapter, autoApproveMilestones);
  if (prepared.complete) throw new AppError("CHAPTER_RANGE_STALE", "该章节范围已经完成。", 409, true);
  return startMastraRun({ novelId, workflowId: "auto-director", target: `${startChapter}-${input.endChapter}`, inputData: prepared.inputData, inputHash: hashInput(prepared.inputData) });
}

export async function startChapterRange(novelId: string, start: number, end: number) {
  await ensureProductionRuntime();
  const state = await novelRepository.get(novelId);
  if (end < start || end - start > 99) throw new AppError("INVALID_CHAPTER_RANGE", "章节范围必须连续且最多 100 章。", 400, true);
  const prepared = await prepareRangeInput(novelId, start, end);
  if (prepared.complete) throw new AppError("CHAPTER_RANGE_STALE", "该章节范围已经完成。", 409, true);
  return startMastraRun({ novelId, workflowId: "chapter-range", target: `${start}-${end}`, inputData: prepared.inputData, inputHash: hashInput(prepared.inputData) });
}

export async function reviewRun(runId: string, review: { action: "approve"; proposal?: ArtifactProposal; brief?: z.infer<typeof novelBriefSchema> } | { action: "revise"; feedback: string; proposal?: ArtifactProposal } | { action: "cancel" }) {
  await ensureProductionRuntime();
  const current = await runView(runId);
  const located = await locateWorkflowRun(runId);
  const run = await located.workflow.createRun({ runId, resourceId: current.novelId });
  if (review.action === "cancel") {
    if (current.status !== "running" && current.status !== "awaiting_review") throw new AppError("RUN_NOT_CANCELABLE", "这次运行已经结束。", 409, false);
    await run.cancel();
    await clearActiveRun(current.novelId, runId);
    return { ...current, status: "canceled" as const, executionStatus: "canceled" as const, proposal: undefined };
  }
  if (current.status !== "awaiting_review") throw new AppError("RUN_NOT_REVIEWABLE", "这次运行当前不能审阅。", 409, true);
  const step = current.currentStep!;
  let resumeData: Record<string, unknown> = review;
  if (review.action === "approve" && review.brief) {
    const existing = artifactProposalSchema.safeParse(current.artifactProposal);
    resumeData = { action: "approve", proposal: { ...(existing.success ? existing.data : { artifactKey: "book:novel_brief", title: "小说简报", format: "markdown", files: [], metadata: {} }), content: renderNovelBrief(review.brief), files: [{ path: "book/novel-brief.md", content: renderNovelBrief(review.brief) }], metadata: { structured: review.brief } } };
  }
  void observeOperation(runId, { workflowId: located.workflowId, novelId: current.novelId, target: current.target }, run.resume({ step, resumeData }));
  return { ...current, status: "running" as const, executionStatus: "running" as const };
}
export async function startNovelBriefRun(novelId: string) { return startWorkflowRun(novelId, "novel-brief"); }
export async function configureVolume(novelId: string, plan: { number: number; startChapter: number; endChapter: number; final: boolean }) {
  const state = await novelRepository.setVolumePlan(novelId, plan);
  return { novel: state, nextAction: decideNextAction(state) };
}
export async function bootstrap() { await Promise.all([ensureDefaultPromptBlocks(), ensureProductionRuntime()]); const [models, novels] = await Promise.all([modelSettings.status(), novelRepository.list()]); return { models, novels, service: { studio: "ready", workbench: "ready" } }; }
export async function providers() { const status = await modelSettings.status(); return loadProviderCatalog(new Set(status.configuredProviders)); }
export async function capabilities() { await ensureDefaultPromptBlocks(); const tools = builtinTools.map((tool) => tool.id); return { agent: { id: "novel-production-agent", tools, processors: ["UnicodeNormalizer", "TokenLimiterProcessor"] }, agents: [{ id: "novel-production-agent", name: "对话与创作助手", tools }, { id: "novel-workflow-agent", name: "Workflow 创作 Agent", tools: [] }], tools: builtinTools, skills: builtinSkills, agentProfiles: builtinAgentProfiles, defaultProjectRecipe: defaultProjectRecipe(), workflows: workflowIds.map((id) => ({ id, ...workflowCatalog[id], stages: [...workflowCatalog[id].stages] })), prompts: promptBlockDefaults.map(({ id, name, description }) => ({ id, name, description })) }; }

export async function recallChatMessages(memory: NonNullable<Awaited<ReturnType<typeof novelProductionAgent.getMemory>>>, novelId: string) { const thread = await memory.getThreadById({ threadId: novelId }); return thread ? (await memory.recall({ threadId: novelId, resourceId: novelId, perPage: 100, page: 0 })).messages : []; }

export async function chatSession(novelId: string) {
  const [, memory] = await Promise.all([novelRepository.get(novelId), novelProductionAgent.getMemory()]);
  const messages = memory ? await recallChatMessages(memory, novelId) : [];
  return { messages };
}

export async function proposeOpeningPreset(novelId: string): Promise<OpeningPresetProposal> {
  const [state, selection, memory, semantic] = await Promise.all([novelRepository.get(novelId), modelSettings.runtimeSelection("planning"), novelProductionAgent.getMemory(), resolvePromptBlock("novel.chat@v5", { novelId, taskType: "planning" })]);
  const messages = memory ? await recallChatMessages(memory, novelId) : [];
  if (!messages.some((message) => message.role === "user")) throw new AppError("DISCOVERY_REQUIRED", "请先和创作搭档聊聊你的想法，再整理开书预设。", 409, true);
  const requestContext = new RequestContext([["model", selection.model], ["novelId", novelId], ["taskType", "planning"], ["modelProfile", "planning"]]);
  const agent = await effectiveNovelProductionAgent(requestContext);
  const result = await agent.generate(`${semantic.content}\n\n${renderOpeningPresetPrompt(state.title, messages)}`, { requestContext, ...structuredOutputOptions(openingPresetProposalSchema) });
  try { return requireStructuredOutput(openingPresetProposalSchema, result.object, "开书预设"); }
  catch (error) { throw new AppError("STRUCTURED_OUTPUT_INVALID", sanitizeProviderError(error), 502, true); }
}

export async function testModelConnection() {
  const selection = await modelSettings.runtimeSelection("chat"); const startedAt = performance.now();
  try { const requestContext = new RequestContext([["model", selection.model], ["taskType", "chat"], ["modelProfile", "chat"]]); const schema = z.object({ ok: z.literal(true) }); const agent = await effectiveNovelProductionAgent(requestContext); const result = await agent.generate("这是一次连接测试。只返回 ok=true。", { requestContext, ...structuredOutputOptions(schema) }); requireStructuredOutput(schema, result.object, "连接测试"); return { ok: true, latencyMs: Math.round(performance.now() - startedAt), model: selection.model }; }
  catch (error) { throw new AppError("MODEL_CONNECTION_FAILED", `连接测试失败：${sanitizeProviderError(error)}`, 502, true); }
}

export async function novelWorkspace(novelId: string) { const state = await novelRepository.get(novelId); const next = decideNextAction(state); return { novel: state, nextAction: next, milestone: state.artifacts[artifactKey("novel_brief")]?.status === "ready" ? "故事圣经" : "小说简报" }; }

export async function novelWorkspaceProjection(novelId: string) {
  const state = await novelRepository.get(novelId);
  const run = state.activeRunId ? await runView(state.activeRunId).catch(() => undefined) : undefined;
  return buildWorkspaceProjection(state, run);
}
