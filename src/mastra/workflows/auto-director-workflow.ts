import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { artifactKey, volumeHandoffKey, type WorkflowId } from "../../domain";
import { assembleNovelContext } from "../../application/context-assembler";
import { NovelRepository, novelInputHash } from "../../infrastructure/novel-repository";
import { artifactProposalSchema } from "../../shared/contracts";
import { artifactWorkflows } from "./artifact-workflows";
import { chapterRangeWorkflow } from "./chapter-workflows";

const inputSchema = z.object({
  novelId: z.string().uuid(),
  startChapter: z.number().int().positive().optional(),
  endChapter: z.number().int().positive(),
  autoApproveMilestones: z.boolean().default(false),
});

const resumeSchema = z.object({
  action: z.enum(["approve", "revise"]),
  feedback: z.string().max(2_000).optional(),
  proposal: artifactProposalSchema.optional(),
});

const outputSchema = z.object({
  status: z.literal("committed"),
  novelId: z.string().uuid(),
  workflowId: z.literal("auto-director"),
  completedThrough: z.number().int().nonnegative(),
});

const repository = new NovelRepository();
const artifactWorkflowById = {
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
};
const bookPlan: Array<{ workflowId: Exclude<WorkflowId, "chapter-production" | "chapter-range" | "novel-export" | "auto-director">; key: string; path: string; title: string; promptId: string; profile: "planning" | "review"; dependsOn: string[]; milestone: boolean }> = [
  { workflowId: "novel-brief", key: "book:novel_brief", path: "book/novel-brief.md", title: "小说简报", promptId: "novel.brief@v2", profile: "planning", dependsOn: [], milestone: true },
  { workflowId: "story-bible", key: "book:story_bible", path: "story-bible.md", title: "故事圣经", promptId: "novel.story_bible@v2", profile: "planning", dependsOn: ["book:novel_brief"], milestone: true },
  { workflowId: "world-bible", key: "book:world_bible", path: "world-bible.md", title: "世界圣经", promptId: "novel.world_bible@v2", profile: "planning", dependsOn: ["book:novel_brief", "book:story_bible"], milestone: false },
  { workflowId: "character-cast", key: "book:character_cast", path: "characters/character-roster.md", title: "角色阵容", promptId: "novel.character_cast@v2", profile: "planning", dependsOn: ["book:novel_brief", "book:story_bible", "book:world_bible"], milestone: false },
  { workflowId: "volume-strategy", key: "book:volume_strategy", path: "volumes/volume-strategy.md", title: "卷战略", promptId: "novel.volume_strategy@v2", profile: "planning", dependsOn: ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast"], milestone: true },
];

async function suspendedStep(workflow: any, runId: string) {
  const state = await workflow.getWorkflowRunById(runId, { fields: ["steps"] });
  const entry = Object.entries(state.steps ?? {}).map(([id, raw]: [string, any]) => [id, Array.isArray(raw) ? raw.at(-1) : raw] as const).find(([, step]) => step?.suspendPayload);
  return entry ? { step: entry[0], payload: entry[1].suspendPayload as Record<string, unknown> } : undefined;
}

const runStep = createStep({
  id: "auto-director-run",
  description: "按依赖检查书级工件，复用现有工件与章节范围工作流，保存子运行并在需要作者决策时暂停。",
  inputSchema,
  outputSchema,
  suspendSchema: z.object({ childRunId: z.string(), childWorkflowId: z.string(), proposal: artifactProposalSchema }),
  resumeSchema,
  retries: 1,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = await repository.get(inputData.novelId);
    if (!state.openingChoices) throw new Error("请先确认开书选择，再启动自动导演");
    const autoApprove = inputData.autoApproveMilestones || state.approvalMode === "auto";

    if (resumeData) {
      const proposal = resumeData.proposal;
      const childRunId = typeof proposal?.metadata.childRunId === "string" ? proposal.metadata.childRunId : undefined;
      const childWorkflowId = typeof proposal?.metadata.childWorkflowId === "string" ? proposal.metadata.childWorkflowId : undefined;
      if (!childRunId || !childWorkflowId) throw new Error("缺少待恢复的自动导演子运行标识");
      const childWorkflow = childWorkflowId === "chapter-range" ? chapterRangeWorkflow : artifactWorkflowById[childWorkflowId as keyof typeof artifactWorkflowById];
      if (!childWorkflow) throw new Error(`未知子工作流：${childWorkflowId}`);
      const child = await childWorkflow.createRun({ runId: childRunId, resourceId: inputData.novelId });
      const suspended = await suspendedStep(childWorkflow, childRunId);
      if (!suspended) throw new Error("子运行已不存在可恢复的暂停步骤");
      const result = await child.resume({ step: suspended.step, resumeData: resumeData.action === "revise" ? resumeData : { action: "approve", proposal: resumeData.proposal } });
      if (result.status === "suspended") {
        const next = await suspendedStep(childWorkflow, childRunId);
        const nextProposal = artifactProposalSchema.safeParse(next?.payload.proposal);
        return suspend({ childRunId, childWorkflowId, proposal: { ...(nextProposal.success ? nextProposal.data : proposal!), metadata: { ...(nextProposal.success ? nextProposal.data.metadata : proposal?.metadata), childRunId, childWorkflowId } } });
      }
      if (result.status !== "success") throw new Error(`子运行恢复后处于 ${result.status} 状态`);
      if (childWorkflowId === "chapter-range") return { status: "committed" as const, novelId: inputData.novelId, workflowId: "auto-director" as const, completedThrough: inputData.endChapter };
    }

    for (const item of bookPlan) {
      if (item.workflowId === "volume-outline") continue;
      if (item.workflowId === "volume-handoff" || item.workflowId === "completion-audit") continue;
      const current = await repository.get(inputData.novelId);
      if (current.artifacts[item.key]?.status === "ready") continue;
      const context = await assembleNovelContext(repository, inputData.novelId, item.dependsOn);
      const workflow = artifactWorkflowById[item.workflowId];
      const child = await workflow.createRun({ resourceId: inputData.novelId });
      const result = await child.start({ inputData: { novelId: inputData.novelId, workflowId: item.workflowId, artifactKey: item.key, artifactPath: item.path, title: item.title, context, inputHash: novelInputHash(current, item.dependsOn), promptId: item.promptId, promptVersion: item.promptId, modelProfile: item.profile, dependsOn: item.dependsOn, requiresReview: item.milestone && !autoApprove } });
      if (result.status === "suspended") {
        const childSuspension = await suspendedStep(workflow, child.runId);
        const parsed = artifactProposalSchema.safeParse(childSuspension?.payload.proposal);
        if (!parsed.success) throw new Error(`${item.workflowId} 暂停时缺少有效提案`);
        return suspend({ childRunId: child.runId, childWorkflowId: item.workflowId, proposal: { ...parsed.data, metadata: { ...parsed.data.metadata, childRunId: child.runId, childWorkflowId: item.workflowId } } });
      }
      if (result.status !== "success") throw new Error(`${item.workflowId} 子运行未完成：${result.status}`);
    }

    let current = await repository.get(inputData.novelId);
    if (current.schemaVersion === 2) {
      const volume = current.volumes[String(current.currentVolume)];
      if (!volume || volume.status !== "active") throw new Error(`第 ${current.currentVolume} 卷尚未配置章节范围`);
      const outlineKey = `volume:${current.currentVolume}:outline`;
      if (current.artifacts[outlineKey]?.status !== "ready") {
        const outlineDependencies = current.currentVolume > 1 ? ["book:volume_strategy", volumeHandoffKey(current.currentVolume - 1)] : ["book:volume_strategy"];
        const context = await assembleNovelContext(repository, inputData.novelId, outlineDependencies);
        const workflow = artifactWorkflowById["volume-outline"];
        const child = await workflow.createRun({ resourceId: inputData.novelId });
        const result = await child.start({ inputData: { novelId: inputData.novelId, workflowId: "volume-outline", target: String(current.currentVolume), artifactKey: outlineKey, artifactPath: `volumes/volume-${String(current.currentVolume).padStart(2, "0")}.md`, title: `第 ${current.currentVolume} 卷骨架与节奏板`, context, inputHash: novelInputHash(current, outlineDependencies), promptId: "novel.volume_outline@v2", promptVersion: "novel.volume_outline@v2", modelProfile: "planning", dependsOn: outlineDependencies, requiresReview: false } });
        if (result.status !== "success") throw new Error(`第 ${current.currentVolume} 卷骨架未完成`);
        current = await repository.get(inputData.novelId);
      }
    }
    const startChapter = inputData.startChapter ?? current.currentChapter;
    if (startChapter !== current.currentChapter) throw new Error(`自动导演应从第 ${current.currentChapter} 章开始`);
    const child = await chapterRangeWorkflow.createRun({ resourceId: inputData.novelId });
    const result = await child.start({ inputData: { novelId: inputData.novelId, start: startChapter, end: inputData.endChapter } });
    if (result.status === "suspended") {
      const childSuspension = await suspendedStep(chapterRangeWorkflow, child.runId);
      const parsed = artifactProposalSchema.safeParse(childSuspension?.payload.proposal);
      if (!parsed.success) throw new Error("章节范围暂停时缺少有效提案");
      return suspend({ childRunId: child.runId, childWorkflowId: "chapter-range", proposal: { ...parsed.data, metadata: { ...parsed.data.metadata, childRunId: child.runId, childWorkflowId: "chapter-range" } } });
    }
    if (result.status !== "success") throw new Error(`章节范围子运行未完成：${result.status}`);
    return { status: "committed" as const, novelId: inputData.novelId, workflowId: "auto-director" as const, completedThrough: inputData.endChapter };
  },
});

export const autoDirectorWorkflow = createWorkflow({ id: "auto-director", description: "书级自动推进协调器", inputSchema, outputSchema }).then(runStep).commit();
