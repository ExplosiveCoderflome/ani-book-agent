import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { openingChoicesSchema } from "../../domain";
import { NovelRepository } from "../../infrastructure/novel-repository";
import { modelSettings } from "../../infrastructure/model-settings";
import { novelBriefSchema, promptVersion, type NovelBrief } from "../../shared/contracts";
import { effectiveNovelProductionAgent } from "../agents/novel-production-agent";
import { renderNovelBriefPrompt } from "../prompts/novel-brief";
import { resolvePromptBlock } from "../prompts/prompt-blocks";

export const briefWorkflowInputSchema = z.object({
  novelId: z.string().uuid(),
  title: z.string().min(1).max(80),
  openingChoices: openingChoicesSchema,
  inputHash: z.string().length(64),
  promptVersion: z.literal(promptVersion),
});

const proposalSchema = briefWorkflowInputSchema.extend({
  brief: novelBriefSchema,
  revisionCount: z.number().int().nonnegative(),
});

const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), brief: novelBriefSchema }),
  z.object({ action: z.literal("revise"), feedback: z.string().min(1).max(2_000) }),
]);

const approvedSchema = proposalSchema.extend({ approvedBrief: novelBriefSchema });
const workflowOutputSchema = z.object({
  status: z.literal("committed"),
  novelId: z.string().uuid(),
  sha256: z.string(),
  duplicate: z.boolean(),
});

type WorkflowInput = z.infer<typeof briefWorkflowInputSchema>;
type Proposal = z.infer<typeof proposalSchema>;

export type GenerateBrief = (input: WorkflowInput, revision?: { feedback: string; priorProposal: NovelBrief }) => Promise<NovelBrief>;
export type CommitBrief = (input: Proposal & { approvedBrief: NovelBrief }) => Promise<{ sha256: string; duplicate: boolean }>;

export function createNovelBriefWorkflow(dependencies: { generateBrief: GenerateBrief; commitBrief: CommitBrief }) {
  const generateBriefStep = createStep({
    id: "generate-novel-brief",
    description: "生成结构化小说简报提案。",
    inputSchema: briefWorkflowInputSchema,
    outputSchema: proposalSchema,
    retries: 2,
    execute: async ({ inputData }) => ({
      ...inputData,
      brief: novelBriefSchema.parse(await dependencies.generateBrief(inputData)),
      revisionCount: 0,
    }),
  });

  const reviewBriefStep = createStep({
    id: "review-novel-brief",
    description: "等待作者批准或提出调整意见。",
    inputSchema: proposalSchema,
    outputSchema: approvedSchema,
    suspendSchema: proposalSchema,
    resumeSchema: reviewSchema,
    retries: 2,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return suspend(inputData);
      if (resumeData.action === "revise") {
        const brief = novelBriefSchema.parse(await dependencies.generateBrief(inputData, {
          feedback: resumeData.feedback,
          priorProposal: inputData.brief,
        }));
        return suspend({ ...inputData, brief, revisionCount: inputData.revisionCount + 1 });
      }
      return { ...inputData, approvedBrief: novelBriefSchema.parse(resumeData.brief) };
    },
  });

  const commitBriefStep = createStep({
    id: "commit-novel-brief",
    description: "校验上下文并提交作者批准的小说简报。",
    inputSchema: approvedSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => {
      const result = await dependencies.commitBrief(inputData);
      return { status: "committed" as const, novelId: inputData.novelId, ...result };
    },
  });

  return createWorkflow({
    id: "advance-novel",
    inputSchema: briefWorkflowInputSchema,
    outputSchema: workflowOutputSchema,
  }).then(generateBriefStep).then(reviewBriefStep).then(commitBriefStep).commit();
}

const repository = new NovelRepository();
export { modelSettings };

export const generateBriefWithAgent: GenerateBrief = async (input, revision) => {
  const selection = await modelSettings.runtimeSelection("planning");
  const semantic = await resolvePromptBlock("novel.brief@v2", { novelId: input.novelId, taskType: "planning", workflowId: "novel-brief" });
  const requestContext = new RequestContext([["model", selection.model], ["novelId", input.novelId], ["taskType", "planning"], ["workflowId", "novel-brief"], ["modelProfile", "planning"]]);
  const agent = await effectiveNovelProductionAgent(requestContext);
  const result = await agent.generate(
    `${semantic.content}\n\n${renderNovelBriefPrompt({
      state: { title: input.title, openingChoices: input.openingChoices },
      feedback: revision?.feedback,
      priorProposal: revision?.priorProposal,
    })}`,
    { requestContext, structuredOutput: { schema: novelBriefSchema } },
  );
  return novelBriefSchema.parse(result.object);
};

export const advanceNovelWorkflow = createNovelBriefWorkflow({
  generateBrief: generateBriefWithAgent,
  commitBrief: async (input) => repository.commitBrief({
    novelId: input.novelId,
    brief: input.approvedBrief,
    expectedInputHash: input.inputHash,
    idempotencyKey: `${input.novelId}:book:novel_brief:${input.inputHash}:${input.promptVersion}`,
  }),
});
