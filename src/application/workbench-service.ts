import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { artifactKey, decideNextAction, workflowIds, type WorkflowId } from "../domain";
import { modelSettings, sanitizeProviderError } from "../infrastructure/model-settings";
import { NovelRepository, novelInputHash, renderNovelBrief } from "../infrastructure/novel-repository";
import { loadProviderCatalog } from "../infrastructure/provider-catalog";
import { recordTokenUsage } from "../infrastructure/token-usage";
import { artifactProposalSchema, chatChoicesSchema, novelBriefSchema, openingPresetProposalSchema, type ArtifactProposal, type RunView } from "../shared/contracts";
import { workflowCatalog } from "../shared/workflow-catalog";
import { effectiveNovelProductionAgent, novelProductionAgent } from "../mastra/agents/novel-production-agent";
import { renderOpeningPresetPrompt } from "../mastra/prompts/opening-preset";
import { ensureDefaultPromptBlocks, promptBlockDefaults, resolvePromptBlock } from "../mastra/prompts/prompt-blocks";
import { artifactWorkflows } from "../mastra/workflows/artifact-workflows";
import { chapterProductionWorkflow, chapterRangeWorkflow, novelExportWorkflow } from "../mastra/workflows/chapter-workflows";
import { autoDirectorWorkflow } from "../mastra/workflows/auto-director-workflow";
import { requireStructuredOutput, structuredOutputOptions } from "../mastra/structured-output";
import { AppError } from "./errors";
import { runEvents } from "./run-events";

export const novelRepository = new NovelRepository();

const workflows: Record<WorkflowId, any> = {
  "novel-brief": artifactWorkflows.novelBriefWorkflow,
  "story-bible": artifactWorkflows.storyBibleWorkflow,
  "world-bible": artifactWorkflows.worldBibleWorkflow,
  "character-cast": artifactWorkflows.characterCastWorkflow,
  "volume-strategy": artifactWorkflows.volumeStrategyWorkflow,
  "volume-outline": artifactWorkflows.volumeOutlineWorkflow,
  "chapter-planning": artifactWorkflows.chapterPlanningWorkflow,
  "quality-repair": artifactWorkflows.qualityRepairWorkflow,
  "chapter-production": chapterProductionWorkflow,
  "chapter-range": chapterRangeWorkflow,
  "novel-export": novelExportWorkflow,
  "auto-director": autoDirectorWorkflow,
};

const activeRuns = new Map<string, { workflowId: WorkflowId; run: any }>();

const definitions: Record<Exclude<WorkflowId, "chapter-production" | "chapter-range" | "novel-export" | "auto-director">, {
  artifactKey: (target?: string) => string; path: (target?: string) => string; title: string; promptId: string; profile: "planning" | "drafting" | "review"; dependsOn: (target?: string) => string[]; milestone: boolean;
}> = {
  "novel-brief": { artifactKey: () => "book:novel_brief", path: () => "book/novel-brief.md", title: "小说简报", promptId: "novel.brief@v2", profile: "planning", dependsOn: () => [], milestone: true },
  "story-bible": { artifactKey: () => "book:story_bible", path: () => "story-bible.md", title: "故事圣经", promptId: "novel.story_bible@v2", profile: "planning", dependsOn: () => ["book:novel_brief"], milestone: true },
  "world-bible": { artifactKey: () => "book:world_bible", path: () => "world-bible.md", title: "世界圣经", promptId: "novel.world_bible@v2", profile: "planning", dependsOn: () => ["book:novel_brief", "book:story_bible"], milestone: false },
  "character-cast": { artifactKey: () => "book:character_cast", path: () => "characters/character-roster.md", title: "角色阵容", promptId: "novel.character_cast@v2", profile: "planning", dependsOn: () => ["book:novel_brief", "book:story_bible", "book:world_bible"], milestone: false },
  "volume-strategy": { artifactKey: () => "book:volume_strategy", path: () => "volumes/volume-strategy.md", title: "卷战略", promptId: "novel.volume_strategy@v2", profile: "planning", dependsOn: () => ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast"], milestone: true },
  "volume-outline": { artifactKey: () => "book:volume_outline", path: () => "volumes/volume-01.md", title: "当前卷骨架与节奏板", promptId: "novel.volume_outline@v2", profile: "planning", dependsOn: () => ["book:volume_strategy"], milestone: false },
  "chapter-planning": { artifactKey: (target) => `chapter:${chapterNumber(target)}:chapter_plan`, path: (target) => `chapters/chapter-${String(chapterNumber(target)).padStart(3, "0")}/plan.md`, title: "章节计划", promptId: "novel.chapter_plan@v2", profile: "planning", dependsOn: (target) => ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast", "book:volume_strategy", "book:volume_outline", ...(chapterNumber(target) > 1 ? [`chapter:${chapterNumber(target) - 1}:continuity_update`, `chapter:${chapterNumber(target) - 1}:humanization_revision`] : [])], milestone: false },
  "quality-repair": { artifactKey: (target) => `chapter:${chapterNumber(target)}:quality_repair`, path: (target) => `chapters/chapter-${String(chapterNumber(target)).padStart(3, "0")}/repair-proposal.md`, title: "质量修复提案", promptId: "novel.chapter_repair@v2", profile: "review", dependsOn: (target) => [`chapter:${chapterNumber(target)}:chapter_plan`, `chapter:${chapterNumber(target)}:humanization_revision`, `chapter:${chapterNumber(target)}:chapter_review`, `chapter:${chapterNumber(target)}:quality_debt`], milestone: false },
};

function chapterNumber(target?: string) {
  const value = Number(target);
  if (!Number.isInteger(value) || value < 1) throw new AppError("INVALID_CHAPTER", "请提供有效章节号。", 400, true);
  return value;
}

async function assembleContext(novelId: string, keys: string[]) {
  const state = await novelRepository.get(novelId);
  const sections = [`作品：${state.title}`, state.openingChoices ? `开书选择：${JSON.stringify(state.openingChoices)}` : "开书选择尚未确认"];
  for (const key of keys) {
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status !== "ready") throw new AppError("DEPENDENCY_NOT_READY", `上游工件 ${key} 尚未就绪。`, 409, true);
    const content = (await novelRepository.readArtifact(novelId, key)).content;
    const bounded = key.endsWith(":humanization_revision") ? content.slice(-6_000) : content.slice(0, 18_000);
    sections.push(`\n## ${key}\n${bounded}`);
  }
  return sections.join("\n");
}

export function statusOf(value: string): RunView["status"] {
  return value === "suspended" ? "awaiting_review" : value === "success" ? "committed" : value === "failed" ? "failed" : value === "canceled" ? "canceled" : "running";
}

export function projectedRunStatus(value: string, hasLocalExecutor: boolean): RunView["status"] {
  const status = statusOf(value);
  return status === "running" && !hasLocalExecutor ? "failed" : status;
}

export function releasesActiveRun(status: RunView["status"]) { return status === "committed" || status === "failed" || status === "canceled"; }
export function shouldClearActiveRun(activeRunId: string | undefined, runId: string) { return activeRunId === runId; }

async function clearActiveRun(novelId: string, runId: string) {
  const state = await novelRepository.get(novelId);
  if (shouldClearActiveRun(state.activeRunId, runId)) await novelRepository.setActiveRun(novelId, undefined);
}

async function locateRun(runId: string) {
  const active = activeRuns.get(runId);
  if (active) return { workflowId: active.workflowId, workflow: workflows[active.workflowId], run: active.run, state: await workflows[active.workflowId].getWorkflowRunById(runId, { fields: ["steps", "result", "error", "payload"] }) };
  for (const workflowId of workflowIds) {
    const state = await workflows[workflowId].getWorkflowRunById(runId, { fields: ["steps", "result", "error", "payload"] }).catch(() => null);
    if (state) return { workflowId, workflow: workflows[workflowId], state };
  }
  throw new AppError("RUN_NOT_FOUND", "没有找到这次运行。", 404, false);
}

export async function runView(runId: string): Promise<RunView> {
  const located = await locateRun(runId);
  const state = located.state;
  const steps = Object.entries(state.steps ?? {}) as Array<[string, any]>;
  const suspended = steps.map(([id, raw]) => [id, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload);
  const envelope = suspended?.[1]?.suspendPayload as Record<string, unknown> | undefined;
  const artifactProposal = artifactProposalSchema.safeParse(envelope?.proposal);
  const legacyProposal = novelBriefSchema.safeParse(envelope?.brief);
  const payload = state.payload as Record<string, unknown> | undefined;
  const result = state.result as Record<string, unknown> | undefined;
  const interrupted = projectedRunStatus(state.status, Boolean(located.run)) === "failed" && statusOf(state.status) === "running";
  return {
    runId, workflowId: located.workflowId, novelId: state.resourceId ?? String(payload?.novelId ?? ""), target: typeof payload?.target === "string" ? payload.target : undefined,
    status: projectedRunStatus(state.status, Boolean(located.run)), currentStep: suspended?.[0] ?? steps.at(-1)?.[0],
    ...(located.workflowId === "novel-brief" && artifactProposal.success && novelBriefSchema.safeParse(artifactProposal.data.metadata.structured).success
      ? { proposal: novelBriefSchema.parse(artifactProposal.data.metadata.structured), artifactProposal: artifactProposal.data }
      : artifactProposal.success ? { artifactProposal: artifactProposal.data } : legacyProposal.success ? { proposal: legacyProposal.data } : {}),
    ...(typeof result?.sha256 === "string" ? { artifactSha256: result.sha256 } : {}),
    ...(typeof result?.path === "string" ? { exportPath: result.path } : {}),
    ...(typeof result?.chapterCount === "number" ? { chapterCount: result.chapterCount } : {}),
    ...(interrupted
      ? { error: { code: "RUN_INTERRUPTED", message: "开发服务在任务执行期间退出，本次运行已中断；权威工件没有被修改，可以重新生成。", recoverable: true } }
      : state.error ? { error: { code: "RUN_FAILED", message: sanitizeProviderError(state.error.message ?? "运行失败"), recoverable: true } } : {}),
  };
}

function observeRun(novelId: string, runId: string, operation: Promise<unknown>) {
  void operation.then(async () => {
    const view = await runView(runId);
    if (view.status === "awaiting_review") { runEvents.publish(runId, "step.completed", { step: view.currentStep }); runEvents.publish(runId, "artifact.proposed", { workflowId: view.workflowId, proposal: view.artifactProposal ?? view.proposal }); runEvents.publish(runId, "approval.required", { workflowId: view.workflowId }); }
    if (view.status === "committed") { runEvents.publish(runId, "artifact.committed", { workflowId: view.workflowId, sha256: view.artifactSha256 }); runEvents.publish(runId, "run.completed", { status: "committed" }); }
    if (view.status === "failed") runEvents.publish(runId, "run.failed", { message: view.error?.message ?? "运行失败" });
    if (releasesActiveRun(view.status)) { activeRuns.delete(runId); await clearActiveRun(novelId, runId).catch(() => undefined); }
  }).catch(async (error) => { runEvents.publish(runId, "run.failed", { message: sanitizeProviderError(error) }); activeRuns.delete(runId); await clearActiveRun(novelId, runId).catch(() => undefined); });
}

async function ensureNoActiveRun(state: Awaited<ReturnType<NovelRepository["get"]>>) {
  if (!state.activeRunId) return;
  const active = await runView(state.activeRunId).catch(() => undefined);
  if (active?.status === "running" || active?.status === "awaiting_review") throw new AppError("RUN_ALREADY_ACTIVE", "这部作品已有运行中的任务。", 409, true);
}

export async function startWorkflowRun(novelId: string, workflowId: WorkflowId, target?: string, extra: Record<string, unknown> = {}): Promise<RunView> {
  await ensureDefaultPromptBlocks();
  const state = await novelRepository.get(novelId);
  await ensureNoActiveRun(state);
  let inputData: Record<string, unknown>;
  if (workflowId === "auto-director") throw new AppError("USE_AUTO_DIRECTOR_API", "请使用自动导演接口。", 400, false);
  if (workflowId === "chapter-production") {
    const chapter = chapterNumber(target ?? String(state.currentChapter));
    if (chapter !== state.currentChapter || chapter > state.approvedChapterEnd) throw new AppError("CHAPTER_NOT_APPROVED", "该章节尚未获得生产授权。", 409, true);
    const dependsOn = definitions["chapter-planning"].dependsOn(String(chapter)).concat(`chapter:${chapter}:chapter_plan`);
    inputData = { novelId, chapter, context: await assembleContext(novelId, dependsOn), inputHash: novelInputHash(state, dependsOn), dependsOn };
  } else if (workflowId === "novel-export") inputData = { novelId, fileName: target };
  else if (workflowId === "chapter-range") throw new AppError("USE_CHAPTER_RANGE_API", "请使用章节范围接口。", 400, false);
  else {
    const definition = definitions[workflowId];
    const dependsOn = definition.dependsOn(target);
    const key = definition.artifactKey(target);
    inputData = { novelId, workflowId, target, artifactKey: key, artifactPath: definition.path(target), title: definition.title, context: await assembleContext(novelId, dependsOn), inputHash: novelInputHash(state, dependsOn), promptId: definition.promptId, promptVersion: definition.promptId, modelProfile: definition.profile, dependsOn, requiresReview: definition.milestone && (state.approvalMode ?? "milestone_approval") === "milestone_approval", ...extra };
  }
  const workflow = workflows[workflowId];
  const run = await workflow.createRun({ resourceId: novelId });
  activeRuns.set(run.runId, { workflowId, run });
  await novelRepository.setActiveRun(novelId, run.runId);
  runEvents.publish(run.runId, "run.started", { novelId, workflowId, target });
  runEvents.publish(run.runId, "step.started", { step: workflowId });
  observeRun(novelId, run.runId, run.start({ inputData }));
  return { runId: run.runId, novelId, workflowId, target, status: "running", currentStep: workflowId };
}

export async function startAutoDirector(novelId: string, input: { startChapter?: number; endChapter: number; autoApproveMilestones?: boolean }) {
  const state = await novelRepository.get(novelId);
  await ensureNoActiveRun(state);
  const startChapter = input.startChapter ?? state.currentChapter;
  if (startChapter !== state.currentChapter) throw new AppError("CHAPTER_RANGE_STALE", `当前应从第 ${state.currentChapter} 章开始。`, 409, true);
  if (input.endChapter < startChapter || input.endChapter - startChapter > 99) throw new AppError("INVALID_CHAPTER_RANGE", "自动导演章节范围必须连续且最多 100 章。", 400, true);
  const run = await autoDirectorWorkflow.createRun({ resourceId: novelId });
  activeRuns.set(run.runId, { workflowId: "auto-director", run });
  await novelRepository.setActiveRun(novelId, run.runId);
  runEvents.publish(run.runId, "run.started", { novelId, workflowId: "auto-director", target: `${startChapter}-${input.endChapter}` });
  observeRun(novelId, run.runId, run.start({ inputData: { novelId, startChapter, endChapter: input.endChapter, autoApproveMilestones: input.autoApproveMilestones ?? false } }));
  return { runId: run.runId, novelId, workflowId: "auto-director" as const, target: `${startChapter}-${input.endChapter}`, status: "running" as const };
}

export async function startChapterRange(novelId: string, start: number, end: number) {
  const state = await novelRepository.get(novelId);
  await ensureNoActiveRun(state);
  if (start !== state.currentChapter) throw new AppError("CHAPTER_RANGE_STALE", `当前应从第 ${state.currentChapter} 章开始。`, 409, true);
  const run = await chapterRangeWorkflow.createRun({ resourceId: novelId });
  activeRuns.set(run.runId, { workflowId: "chapter-range", run });
  await novelRepository.setActiveRun(novelId, run.runId);
  runEvents.publish(run.runId, "run.started", { novelId, workflowId: "chapter-range", target: `${start}-${end}` });
  observeRun(novelId, run.runId, run.start({ inputData: { novelId, start, end } }));
  return { runId: run.runId, novelId, workflowId: "chapter-range" as const, target: `${start}-${end}`, status: "running" as const };
}

export async function reviewRun(runId: string, review: { action: "approve"; proposal?: ArtifactProposal; brief?: z.infer<typeof novelBriefSchema> } | { action: "revise"; feedback: string; proposal?: ArtifactProposal } | { action: "cancel" }) {
  const current = await runView(runId);
  const located = await locateRun(runId);
  const run = located.run ?? await located.workflow.createRun({ runId, resourceId: current.novelId });
  if (review.action === "cancel") { if (current.status !== "running" && current.status !== "awaiting_review") throw new AppError("RUN_NOT_CANCELABLE", "这次运行已经结束。", 409, false); await run.cancel(); activeRuns.delete(runId); await novelRepository.setActiveRun(current.novelId, undefined); runEvents.publish(runId, "run.completed", { status: "canceled" }); return { ...current, status: "canceled" as const, proposal: undefined }; }
  if (current.status !== "awaiting_review") throw new AppError("RUN_NOT_REVIEWABLE", "这次运行当前不能审阅。", 409, true);
  const step = current.currentStep!;
  let resumeData: Record<string, unknown> = review;
  if (review.action === "approve" && review.brief) {
    const existing = artifactProposalSchema.safeParse(current.artifactProposal);
    resumeData = { action: "approve", proposal: { ...(existing.success ? existing.data : { artifactKey: "book:novel_brief", title: "小说简报", format: "markdown", files: [], metadata: {} }), content: renderNovelBrief(review.brief), files: [{ path: "book/novel-brief.md", content: renderNovelBrief(review.brief) }], metadata: { structured: review.brief } } };
  }
  runEvents.publish(runId, "step.started", { step, action: review.action });
  observeRun(current.novelId, runId, run.resume({ step, resumeData }));
  return { ...current, status: "running" as const };
}

export async function startNovelBriefRun(novelId: string) { return startWorkflowRun(novelId, "novel-brief"); }
export async function bootstrap() { await ensureDefaultPromptBlocks(); const [models, novels] = await Promise.all([modelSettings.status(), novelRepository.list()]); return { models, novels, service: { studio: "ready", workbench: "ready" } }; }
export async function providers() { const status = await modelSettings.status(); return loadProviderCatalog(new Set(status.configuredProviders)); }
export async function capabilities() { await ensureDefaultPromptBlocks(); return { agent: { id: "novel-production-agent", tools: ["get_novel_status", "list_novel_artifacts", "read_novel_artifact", "get_chapter_context", "inspect_continuity", "list_workflow_capabilities"], processors: ["UnicodeNormalizer", "TokenLimiterProcessor"] }, workflows: workflowIds.map((id) => ({ id, ...workflowCatalog[id], stages: [...workflowCatalog[id].stages] })), prompts: promptBlockDefaults.map(({ id, name, description }) => ({ id, name, description })) }; }

export async function recallChatMessages(memory: NonNullable<Awaited<ReturnType<typeof novelProductionAgent.getMemory>>>, novelId: string) { const thread = await memory.getThreadById({ threadId: novelId }); return thread ? (await memory.recall({ threadId: novelId, resourceId: novelId, perPage: 100, page: 0 })).messages : []; }

export async function chatSession(novelId: string) {
  const [, memory] = await Promise.all([novelRepository.get(novelId), novelProductionAgent.getMemory()]);
  const messages = memory ? await recallChatMessages(memory, novelId) : [];
  return { messages };
}

export async function chatStream(novelId: string, message: string, abortSignal?: AbortSignal) {
  await novelRepository.get(novelId);
  const selection = await modelSettings.runtimeSelection("chat");
  const requestContext = new RequestContext([["novelId", novelId], ["taskType", "chat"], ["modelProfile", "chat"]]);
  const agent = await effectiveNovelProductionAgent(requestContext);
  const output = await agent.stream(message, { requestContext, memory: { thread: novelId, resource: novelId }, abortSignal, modelSettings: { temperature: selection.parameters.temperature, topP: selection.parameters.topP, maxOutputTokens: selection.parameters.maxOutputTokens } });
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        let assistantText = "";
        const reader = output.textStream.getReader();
        while (true) { const part = await reader.read(); if (part.done) break; if (part.value) { assistantText += part.value; send("text-delta", { text: part.value }); } }
        try {
          const choicePrompt = await resolvePromptBlock("novel.chat_choices@v2", { novelId, taskType: "chat" });
          const choiceContext = new RequestContext([["model", selection.model], ["novelId", novelId], ["taskType", "planning"], ["modelProfile", "chat"]]);
          const choiceAgent = await effectiveNovelProductionAgent(choiceContext);
          const choiceResult = await choiceAgent.generate(`${choicePrompt.content}\n\n作者本轮消息：\n${message}\n\n创作搭档本轮回复：\n${assistantText}`, { requestContext: choiceContext, ...structuredOutputOptions(chatChoicesSchema), modelSettings: { temperature: 0.2, maxOutputTokens: 1_000 } });
          const choices = requireStructuredOutput(chatChoicesSchema, choiceResult.object, "对话快捷选择").choices;
          if (choices.length) send("choices", { choices });
          await recordTokenUsage(novelId, { task: "chat-choices", promptVersion: choicePrompt.version, usage: choiceResult.usage });
        } catch (error) {
          const message = sanitizeProviderError(error);
          console.warn("对话快捷选择生成失败", { novelId, error: message });
          send("choices-error", { message: `快捷选项未能生成，你仍可以直接输入选择。${message}` });
        }
        const usage = await output.usage; await recordTokenUsage(novelId, { task: "chat", promptVersion: "novel.chat@v2", usage }); send("finish", { runId: output.runId, usage });
      } catch (error) { send("error", { message: sanitizeProviderError(error) }); }
      finally { controller.close(); }
    },
    cancel() { void output.consumeStream().catch(() => undefined); },
  });
}

export async function proposeOpeningPreset(novelId: string) {
  const [state, selection, memory, semantic] = await Promise.all([novelRepository.get(novelId), modelSettings.runtimeSelection("planning"), novelProductionAgent.getMemory(), resolvePromptBlock("novel.chat@v2", { novelId, taskType: "planning" })]);
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
