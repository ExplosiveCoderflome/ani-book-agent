import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { workflowIdSchema, type WorkflowId } from "../../domain";
import { modelSettings } from "../../infrastructure/model-settings";
import { NovelRepository, renderNovelBrief } from "../../infrastructure/novel-repository";
import { recordTokenUsage } from "../../infrastructure/token-usage";
import { artifactProposalSchema, novelBriefSchema, type ArtifactProposal, type ModelProfileName } from "../../shared/contracts";
import { workflowCatalog } from "../../shared/workflow-catalog";
import { effectiveNovelProductionAgent } from "../agents/novel-production-agent";
import { resolvePromptBlock } from "../prompts/prompt-blocks";
import { requireStructuredOutput, structuredOutputOptions } from "../structured-output";

export const artifactWorkflowInputSchema = z.object({
  novelId: z.string().uuid(),
  workflowId: workflowIdSchema,
  target: z.string().optional(),
  artifactKey: z.string().min(1),
  artifactPath: z.string().min(1),
  title: z.string().min(1),
  context: z.string(),
  inputHash: z.string().length(64),
  promptId: z.string().min(1),
  promptVersion: z.string().min(1),
  modelProfile: z.enum(["planning", "drafting", "review", "chat"]),
  dependsOn: z.array(z.string()).default([]),
  requiresReview: z.boolean(),
});

const proposalEnvelopeSchema = artifactWorkflowInputSchema.extend({ proposal: artifactProposalSchema, resolvedPromptVersion: z.string() });
const resumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), proposal: artifactProposalSchema.optional() }),
  z.object({ action: z.literal("revise"), feedback: z.string().min(1).max(2_000) }),
]);
const approvedEnvelopeSchema = proposalEnvelopeSchema.extend({ approvedProposal: artifactProposalSchema });
const outputSchema = z.object({ status: z.literal("committed"), novelId: z.string().uuid(), workflowId: workflowIdSchema, sha256: z.string(), duplicate: z.boolean() });

type WorkflowInput = z.infer<typeof artifactWorkflowInputSchema>;
const repository = new NovelRepository();

async function generateProposal(input: WorkflowInput, revision?: { feedback: string; prior: ArtifactProposal }) {
  const selection = await modelSettings.runtimeSelection(input.modelProfile as ModelProfileName);
  const prompt = await resolvePromptBlock(input.promptId, { novelId: input.novelId, taskType: input.modelProfile === "review" ? "review" : "planning", workflowId: input.workflowId });
  const requestContext = new RequestContext([
    ["model", selection.model], ["novelId", input.novelId], ["taskType", input.modelProfile === "review" ? "review" : "planning"], ["workflowId", input.workflowId], ["modelProfile", input.modelProfile],
  ]);
  const revisionText = revision ? `\n\n作者调整意见：${revision.feedback}\n上一版提案：\n${revision.prior.content}` : "";
  const instruction = `${prompt.content}\n\n权威上下文：\n${input.context}${revisionText}`;
  const agent = await effectiveNovelProductionAgent(requestContext);
  if (input.workflowId === "novel-brief") {
    const result = await agent.generate(instruction, { requestContext, ...structuredOutputOptions(novelBriefSchema) });
    await recordTokenUsage(input.novelId, { task: input.workflowId, promptVersion: prompt.version, usage: result.usage });
    const brief = requireStructuredOutput(novelBriefSchema, result.object, "小说简报");
    const content = renderNovelBrief(brief);
    return { proposal: { artifactKey: input.artifactKey, title: input.title, format: "markdown" as const, content, files: [{ path: input.artifactPath, content }], metadata: { structured: brief } }, resolvedPromptVersion: prompt.version };
  }
  const result = await agent.generate(`${instruction}\n\n请返回工件提案。artifactKey 必须为 ${input.artifactKey}，主文件路径必须为 ${input.artifactPath}。`, {
    requestContext,
    ...structuredOutputOptions(artifactProposalSchema),
    modelSettings: { temperature: selection.parameters.temperature, topP: selection.parameters.topP, maxOutputTokens: selection.parameters.maxOutputTokens },
  });
  const parsed = requireStructuredOutput(artifactProposalSchema, result.object, input.title);
  await recordTokenUsage(input.novelId, { task: input.workflowId, promptVersion: prompt.version, usage: result.usage });
  return {
    proposal: { ...parsed, artifactKey: input.artifactKey, title: input.title, files: [{ path: input.artifactPath, content: parsed.content }, ...parsed.files.filter((file) => file.path !== input.artifactPath)] },
    resolvedPromptVersion: prompt.version,
  };
}

export function createArtifactWorkflow(id: WorkflowId) {
  const descriptor = workflowCatalog[id];
  const generate = createStep({
    id: `${id}-generate`, description: `读取已装配的权威上下文，按版本化 Prompt 生成“${descriptor.name}”结构化提案并记录模型用量。`, inputSchema: artifactWorkflowInputSchema, outputSchema: proposalEnvelopeSchema, retries: 2,
    execute: async ({ inputData }) => ({ ...inputData, ...(await generateProposal(inputData)) }),
  });
  const review = createStep({
    id: `${id}-review`, description: `按审批策略处理“${descriptor.name}”：自动通过，或暂停等待作者批准、编辑与要求重生成。`, inputSchema: proposalEnvelopeSchema, outputSchema: approvedEnvelopeSchema, suspendSchema: proposalEnvelopeSchema, resumeSchema, retries: 2,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!inputData.requiresReview) return { ...inputData, approvedProposal: inputData.proposal };
      if (!resumeData) return suspend(inputData);
      if (resumeData.action === "revise") return suspend({ ...inputData, ...(await generateProposal(inputData, { feedback: resumeData.feedback, prior: inputData.proposal })) });
      return { ...inputData, approvedProposal: resumeData.proposal ?? inputData.proposal };
    },
  });
  const commit = createStep({
    id: `${id}-commit`, description: `重新校验输入哈希，以幂等键原子提交“${descriptor.name}”，并登记依赖、版本与作者保护状态。`, inputSchema: approvedEnvelopeSchema, outputSchema,
    execute: async ({ inputData }) => {
      const result = await repository.commitProposal({ novelId: inputData.novelId, proposal: inputData.approvedProposal, expectedInputHash: inputData.inputHash, promptVersion: inputData.resolvedPromptVersion, idempotencyKey: `${inputData.novelId}:${inputData.artifactKey}:${inputData.inputHash}:${inputData.resolvedPromptVersion}`, dependsOn: inputData.dependsOn });
      return { status: "committed" as const, novelId: inputData.novelId, workflowId: id, sha256: result.sha256, duplicate: result.duplicate };
    },
  });
  return createWorkflow({ id, description: descriptor.description, metadata: { displayName: descriptor.name, target: descriptor.target, approval: descriptor.approval, stages: [...descriptor.stages] }, inputSchema: artifactWorkflowInputSchema, outputSchema }).then(generate).then(review).then(commit).commit();
}

export const novelBriefWorkflow = createArtifactWorkflow("novel-brief");
export const storyBibleWorkflow = createArtifactWorkflow("story-bible");
export const worldBibleWorkflow = createArtifactWorkflow("world-bible");
export const characterCastWorkflow = createArtifactWorkflow("character-cast");
export const volumeStrategyWorkflow = createArtifactWorkflow("volume-strategy");
export const volumeOutlineWorkflow = createArtifactWorkflow("volume-outline");
export const chapterPlanningWorkflow = createArtifactWorkflow("chapter-planning");
export const qualityRepairWorkflow = createArtifactWorkflow("quality-repair");

export const artifactWorkflows = { novelBriefWorkflow, storyBibleWorkflow, worldBibleWorkflow, characterCastWorkflow, volumeStrategyWorkflow, volumeOutlineWorkflow, chapterPlanningWorkflow, qualityRepairWorkflow };
