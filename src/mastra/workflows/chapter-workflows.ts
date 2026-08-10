import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { stringify } from "yaml";
import { z } from "zod";
import { modelSettings } from "../../infrastructure/model-settings";
import { NovelRepository } from "../../infrastructure/novel-repository";
import { novelInputHash } from "../../infrastructure/novel-repository";
import { recordTokenUsage } from "../../infrastructure/token-usage";
import { effectiveNovelProductionAgent } from "../agents/novel-production-agent";
import { resolvePromptBlock } from "../prompts/prompt-blocks";
import { chapterPlanningWorkflow } from "./artifact-workflows";

export const chapterProductionInputSchema = z.object({
  novelId: z.string().uuid(), chapter: z.number().int().positive(), context: z.string(), inputHash: z.string().length(64), dependsOn: z.array(z.string()),
});

const draftedSchema = chapterProductionInputSchema.extend({ draft: z.string().min(1), promptVersions: z.record(z.string(), z.string()) });
const humanizedSchema = draftedSchema.extend({ humanized: z.string().min(1) });
export const chapterReviewSchema = z.object({
  verdict: z.enum(["accepted", "continue_with_warning", "local_patch_plan", "rewrite_needed", "stop_for_replan"]),
  summary: z.string(), issues: z.array(z.object({ evidence: z.string(), severity: z.enum(["low", "medium", "high", "critical"]), repair: z.string() })).default([]),
  qualityDebt: z.array(z.string()).default([]),
});
const reviewedSchema = humanizedSchema.extend({ review: chapterReviewSchema });
const repairResumeSchema = z.discriminatedUnion("action", [z.object({ action: z.literal("approve") }), z.object({ action: z.literal("revise"), feedback: z.string().min(1).max(2_000) })]);
const repairedSchema = reviewedSchema.extend({ finalText: z.string().min(1), repairCount: z.number().int().min(0).max(2) });
const continuitySchema = z.object({ facts: z.array(z.string()), characterStates: z.array(z.string()), resources: z.array(z.string()), relationships: z.array(z.string()), payoffs: z.array(z.string()), worldChanges: z.array(z.string()) });
const continuityEnvelopeSchema = repairedSchema.extend({ continuity: continuitySchema });
const outputSchema = z.object({ status: z.literal("committed"), novelId: z.string().uuid(), workflowId: z.literal("chapter-production"), chapter: z.number(), sha256: z.string(), verdict: chapterReviewSchema.shape.verdict });

const repository = new NovelRepository();

async function contextFor(input: { novelId: string; chapter: number }, taskType: "drafting" | "review" | "continuity", profile: "drafting" | "review", promptId: string) {
  const selection = await modelSettings.runtimeSelection(profile);
  const prompt = await resolvePromptBlock(promptId, { novelId: input.novelId, taskType, workflowId: "chapter-production", chapter: input.chapter });
  return { selection, prompt, requestContext: new RequestContext([["model", selection.model], ["novelId", input.novelId], ["taskType", taskType], ["workflowId", "chapter-production"], ["modelProfile", profile]]) };
}

async function textGeneration(input: { novelId: string; chapter: number }, profile: "drafting" | "review", promptId: string, body: string) {
  const call = await contextFor(input, profile === "review" ? "review" : "drafting", profile, promptId);
  const agent = await effectiveNovelProductionAgent(call.requestContext);
  const result = await agent.generate(`${call.prompt.content}\n\n${body}`, { requestContext: call.requestContext, modelSettings: { temperature: call.selection.parameters.temperature, topP: call.selection.parameters.topP, maxOutputTokens: call.selection.parameters.maxOutputTokens } });
  await recordTokenUsage(input.novelId, { task: promptId, promptVersion: call.prompt.version, usage: result.usage });
  if (!result.text?.trim()) throw new Error("模型没有返回可用正文");
  return { text: result.text.trim(), version: call.prompt.version };
}

const draftStep = createStep({
  id: "chapter-draft", description: "依据章节合同生成整章初稿。", inputSchema: chapterProductionInputSchema, outputSchema: draftedSchema, retries: 2,
  execute: async ({ inputData }) => { const result = await textGeneration(inputData, "drafting", "novel.chapter_writer@v2", `章节：${inputData.chapter}\n权威最小上下文：\n${inputData.context}`); return { ...inputData, draft: result.text, promptVersions: { writer: result.version } }; },
});
const humanizeStep = createStep({
  id: "chapter-humanize", description: "执行一次受约束的反模板化二稿。", inputSchema: draftedSchema, outputSchema: humanizedSchema, retries: 2,
  execute: async ({ inputData }) => { const result = await textGeneration(inputData, "drafting", "novel.chapter_humanize@v2", `章节合同与上下文：\n${inputData.context}\n\n初稿：\n${inputData.draft}`); return { ...inputData, humanized: result.text, promptVersions: { ...inputData.promptVersions, humanize: result.version } }; },
});
const reviewStep = createStep({
  id: "chapter-review", description: "按共享章节合同执行结构化审查。", inputSchema: humanizedSchema, outputSchema: reviewedSchema, retries: 2,
  execute: async ({ inputData }) => {
    const call = await contextFor(inputData, "review", "review", "novel.chapter_review@v2");
    const agent = await effectiveNovelProductionAgent(call.requestContext);
    const result = await agent.generate(`${call.prompt.content}\n\n章节合同与上下文：\n${inputData.context}\n\n待审正文：\n${inputData.humanized}`, { requestContext: call.requestContext, structuredOutput: { schema: chapterReviewSchema }, modelSettings: { temperature: call.selection.parameters.temperature, topP: call.selection.parameters.topP, maxOutputTokens: call.selection.parameters.maxOutputTokens } });
    await recordTokenUsage(inputData.novelId, { task: "chapter-review", promptVersion: call.prompt.version, usage: result.usage });
    return { ...inputData, review: chapterReviewSchema.parse(result.object), promptVersions: { ...inputData.promptVersions, review: call.prompt.version } };
  },
});
const repairStep = createStep({
  id: "chapter-repair", description: "有限修复：局部一次，必要时整章一次。", inputSchema: reviewedSchema, outputSchema: repairedSchema, suspendSchema: reviewedSchema, resumeSchema: repairResumeSchema, retries: 1,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (inputData.review.verdict === "accepted" || inputData.review.verdict === "continue_with_warning") return { ...inputData, finalText: inputData.humanized, repairCount: 0 };
    if (inputData.review.verdict === "stop_for_replan" && !resumeData) return suspend(inputData);
    const feedback = resumeData?.action === "revise" ? `\n作者处理意见：${resumeData.feedback}` : "";
    const result = await textGeneration(inputData, "drafting", "novel.chapter_repair@v2", `章节合同：\n${inputData.context}\n\n审查：\n${JSON.stringify(inputData.review)}${feedback}\n\n待修正文：\n${inputData.humanized}`);
    return { ...inputData, finalText: result.text, repairCount: 1, promptVersions: { ...inputData.promptVersions, repair: result.version } };
  },
});
const continuityStep = createStep({
  id: "chapter-continuity", description: "只从稳定正文抽取连续性 delta。", inputSchema: repairedSchema, outputSchema: continuityEnvelopeSchema, retries: 2,
  execute: async ({ inputData }) => {
    const call = await contextFor(inputData, "continuity", "review", "novel.continuity_extract@v2");
    const agent = await effectiveNovelProductionAgent(call.requestContext);
    const result = await agent.generate(`${call.prompt.content}\n\n最终正文：\n${inputData.finalText}`, { requestContext: call.requestContext, structuredOutput: { schema: continuitySchema }, modelSettings: { temperature: call.selection.parameters.temperature, topP: call.selection.parameters.topP, maxOutputTokens: call.selection.parameters.maxOutputTokens } });
    await recordTokenUsage(inputData.novelId, { task: "continuity-extract", promptVersion: call.prompt.version, usage: result.usage });
    return { ...inputData, continuity: continuitySchema.parse(result.object), promptVersions: { ...inputData.promptVersions, continuity: call.prompt.version } };
  },
});
const commitStep = createStep({
  id: "chapter-commit", description: "原子提交正文、审查和连续性资产。", inputSchema: continuityEnvelopeSchema, outputSchema,
  execute: async ({ inputData }) => {
    const prefix = `chapters/chapter-${String(inputData.chapter).padStart(3, "0")}`;
    const promptVersion = Object.values(inputData.promptVersions).join("+");
    const result = await repository.commitBundle({ novelId: inputData.novelId, expectedInputHash: inputData.inputHash, promptVersion, dependsOn: inputData.dependsOn, continuityDelta: { chapter: inputData.chapter, ...inputData.continuity }, artifacts: [
      { key: `chapter:${inputData.chapter}:context_package`, path: `${prefix}/context-package.md`, content: `# 第 ${inputData.chapter} 章上下文包\n\n${inputData.context}\n` },
      { key: `chapter:${inputData.chapter}:chapter_draft`, path: `${prefix}/draft.md`, content: inputData.draft },
      { key: `chapter:${inputData.chapter}:humanization_revision`, path: `${prefix}/draft-humanized.md`, content: inputData.finalText },
      { key: `chapter:${inputData.chapter}:chapter_review`, path: `${prefix}/review.md`, content: `# 第 ${inputData.chapter} 章审查\n\n- 判定：${inputData.review.verdict}\n- 摘要：${inputData.review.summary}\n\n${inputData.review.issues.map((item) => `- [${item.severity}] ${item.evidence}：${item.repair}`).join("\n")}\n` },
      { key: `chapter:${inputData.chapter}:continuity_update`, path: `continuity/chapter-deltas/chapter-${String(inputData.chapter).padStart(3, "0")}.yaml`, content: stringify({ chapter: inputData.chapter, source: `${prefix}/draft-humanized.md`, ...inputData.continuity }) },
      ...(inputData.review.qualityDebt.length ? [{ key: `chapter:${inputData.chapter}:quality_debt`, path: `production/quality-debt-chapter-${String(inputData.chapter).padStart(3, "0")}.md`, content: inputData.review.qualityDebt.map((item) => `- ${item}`).join("\n") }] : []),
    ] });
    await repository.appendQualityDebt(inputData.novelId, inputData.chapter, inputData.review.qualityDebt).catch(() => undefined);
    return { status: "committed" as const, novelId: inputData.novelId, workflowId: "chapter-production" as const, chapter: inputData.chapter, sha256: result.sha256, verdict: inputData.review.verdict };
  },
});

export const chapterProductionWorkflow = createWorkflow({ id: "chapter-production", inputSchema: chapterProductionInputSchema, outputSchema }).then(draftStep).then(humanizeStep).then(reviewStep).then(repairStep).then(continuityStep).then(commitStep).commit();

const rangeInputSchema = z.object({ novelId: z.string().uuid(), start: z.number().int().positive(), end: z.number().int().positive() });
const rangeItemSchema = z.object({ novelId: z.string().uuid(), chapter: z.number().int().positive() });
const rangeItemOutputSchema = rangeItemSchema.extend({ verdict: chapterReviewSchema.shape.verdict });
const rangeSuspendSchema = rangeItemSchema.extend({ childRunId: z.string(), proposal: z.object({ artifactKey: z.string(), title: z.string(), format: z.literal("markdown"), content: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })), metadata: z.record(z.string(), z.unknown()) }) });
const rangeResumeSchema = z.discriminatedUnion("action", [z.object({ action: z.literal("approve"), proposal: z.object({ artifactKey: z.string(), title: z.string(), format: z.literal("markdown"), content: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })), metadata: z.record(z.string(), z.unknown()) }).optional() }), z.object({ action: z.literal("revise"), feedback: z.string().min(1).max(2_000), proposal: z.object({ artifactKey: z.string(), title: z.string(), format: z.literal("markdown"), content: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })), metadata: z.record(z.string(), z.unknown()) }).optional() })]);
const rangeOutputSchema = z.object({ status: z.literal("committed"), novelId: z.string().uuid(), workflowId: z.literal("chapter-range"), completed: z.array(z.number()) });

async function assembleRangeContext(novelId: string, keys: string[]) {
  const state = await repository.get(novelId);
  const sections = [`作品：${state.title}`, `开书选择：${JSON.stringify(state.openingChoices ?? {})}`];
  for (const key of keys) {
    const item = state.artifacts[key];
    if (!item || item.status !== "ready") throw new Error(`上游工件 ${key} 尚未就绪`);
    const content = (await repository.readArtifact(novelId, key)).content;
    sections.push(`\n## ${key}\n${key.endsWith(":humanization_revision") ? content.slice(-6_000) : content.slice(0, 18_000)}`);
  }
  return sections.join("\n");
}

const prepareRangeStep = createStep({
  id: "prepare-chapter-range", inputSchema: rangeInputSchema, outputSchema: z.array(rangeItemSchema),
  execute: async ({ inputData }) => { await repository.setChapterRange(inputData.novelId, inputData.start, inputData.end); return Array.from({ length: inputData.end - inputData.start + 1 }, (_, index) => ({ novelId: inputData.novelId, chapter: inputData.start + index })); },
});
const produceRangeItemStep = createStep({
  id: "produce-range-chapter", inputSchema: rangeItemSchema, outputSchema: rangeItemOutputSchema, suspendSchema: rangeSuspendSchema, resumeSchema: rangeResumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData) {
      const proposal = resumeData.proposal;
      const childRunId = typeof proposal?.metadata.childRunId === "string" ? proposal.metadata.childRunId : undefined;
      if (!childRunId) throw new Error("缺少待恢复的章节子运行标识");
      const childRun = await chapterProductionWorkflow.createRun({ runId: childRunId, resourceId: inputData.novelId });
      const resumed = await childRun.resume({ step: "chapter-repair", resumeData: resumeData.action === "revise" ? resumeData : { action: "approve" } });
      if (resumed.status !== "success") throw new Error(`第 ${inputData.chapter} 章恢复后处于 ${resumed.status}`);
      return { ...inputData, verdict: resumed.result.verdict };
    }
    const beforePlan = await repository.get(inputData.novelId);
    if (beforePlan.currentChapter !== inputData.chapter) throw new Error(`章节串行游标应为 ${inputData.chapter}，实际为 ${beforePlan.currentChapter}`);
    const planningDependencies = ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast", "book:volume_strategy", "book:volume_outline", ...(inputData.chapter > 1 ? [`chapter:${inputData.chapter - 1}:continuity_update`, `chapter:${inputData.chapter - 1}:humanization_revision`] : [])];
    const planRun = await chapterPlanningWorkflow.createRun({ resourceId: inputData.novelId });
    const planResult = await planRun.start({ inputData: { novelId: inputData.novelId, workflowId: "chapter-planning" as const, target: String(inputData.chapter), artifactKey: `chapter:${inputData.chapter}:chapter_plan`, artifactPath: `chapters/chapter-${String(inputData.chapter).padStart(3, "0")}/plan.md`, title: `第 ${inputData.chapter} 章计划`, context: await assembleRangeContext(inputData.novelId, planningDependencies), inputHash: novelInputHash(beforePlan, planningDependencies), promptId: "novel.chapter_plan@v2", promptVersion: "novel.chapter_plan@v2", modelProfile: "planning" as const, dependsOn: planningDependencies, requiresReview: false } });
    if (planResult.status !== "success") throw new Error(`第 ${inputData.chapter} 章计划未完成`);
    const beforeDraft = await repository.get(inputData.novelId);
    const productionDependencies = [...planningDependencies, `chapter:${inputData.chapter}:chapter_plan`];
    const productionRun = await chapterProductionWorkflow.createRun({ resourceId: inputData.novelId });
    const productionResult = await productionRun.start({ inputData: { novelId: inputData.novelId, chapter: inputData.chapter, context: await assembleRangeContext(inputData.novelId, productionDependencies), inputHash: novelInputHash(beforeDraft, productionDependencies), dependsOn: productionDependencies } });
    if (productionResult.status === "suspended") return suspend({ ...inputData, childRunId: productionRun.runId, proposal: { artifactKey: `chapter:${inputData.chapter}:structural_replan`, title: `第 ${inputData.chapter} 章需要结构性处理`, format: "markdown" as const, content: "本章审查认为现有职责与相邻计划存在结构性冲突。请批准按审查意见修复，或填写新的处理意见。", files: [], metadata: { childRunId: productionRun.runId } } });
    if (productionResult.status !== "success") throw new Error(`第 ${inputData.chapter} 章在 ${productionResult.status} 状态停止`);
    return { ...inputData, verdict: productionResult.result.verdict };
  },
});
const finishRangeStep = createStep({
  id: "finish-chapter-range", inputSchema: z.array(rangeItemOutputSchema), outputSchema: rangeOutputSchema,
  execute: async ({ inputData }) => ({ status: "committed" as const, novelId: inputData[0]?.novelId ?? "", workflowId: "chapter-range" as const, completed: inputData.map((item) => item.chapter) }),
});
export const chapterRangeWorkflow = createWorkflow({ id: "chapter-range", inputSchema: rangeInputSchema, outputSchema: rangeOutputSchema }).then(prepareRangeStep).foreach(produceRangeItemStep, { concurrency: 1 }).then(finishRangeStep).commit();

const exportInputSchema = z.object({ novelId: z.string().uuid(), fileName: z.string().max(80).optional() });
const exportOutputSchema = z.object({ status: z.literal("committed"), novelId: z.string().uuid(), workflowId: z.literal("novel-export"), path: z.string(), chapterCount: z.number(), sha256: z.string() });
export const novelExportWorkflow = createWorkflow({ id: "novel-export", inputSchema: exportInputSchema, outputSchema: exportOutputSchema }).then(createStep({
  id: "export-stable-chapters", inputSchema: exportInputSchema, outputSchema: exportOutputSchema,
  execute: async ({ inputData }) => ({ status: "committed" as const, novelId: inputData.novelId, workflowId: "novel-export" as const, ...(await repository.exportStableChapters(inputData.novelId, inputData.fileName)) }),
})).commit();
