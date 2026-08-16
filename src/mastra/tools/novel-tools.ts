import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { decideNextAction, isMultiVolumeProduction } from "../../domain";
import { AppError } from "../../application/errors";
import { NovelRepository } from "../../infrastructure/novel-repository";
import { chatChoicesSchema, openingPresetProposalSchema } from "../../shared/contracts";
import { workflowCatalog } from "../../shared/workflow-catalog";

const repository = new NovelRepository();
// novelId is request-scoped authority; accepting it from model arguments lets stale
// memory inject example IDs and causes avoidable validation retries.
const novelIdInput = z.object({});

function requireNovelId(_input: unknown, context: { requestContext: { get(key: string): unknown } }) {
  const novelId = context.requestContext.get("novelId");
  return z.string().uuid().parse(novelId);
}

export const getNovelStatusTool = createTool({
  id: "get_novel_status",
  description: "读取当前小说阶段、唯一下一步、活动运行和作者保护状态。只读。",
  inputSchema: novelIdInput,
  outputSchema: z.object({ title: z.string(), nextAction: z.unknown(), activeRunId: z.string().optional(), protectedArtifacts: z.array(z.string()) }),
  execute: async (input, context) => {
    const state = await repository.get(requireNovelId(input, context));
    return { title: state.title, nextAction: decideNextAction(state), activeRunId: state.activeRunId, protectedArtifacts: Object.entries(state.artifacts).filter(([, value]) => value.protected).map(([key]) => key) };
  },
});

export const listNovelArtifactsTool = createTool({
  id: "list_novel_artifacts",
  description: "列出小说工件的状态、版本、依赖、哈希和保护标记。只读。",
  inputSchema: novelIdInput,
  outputSchema: z.object({ artifacts: z.array(z.unknown()) }),
  execute: async (input, context) => ({ artifacts: await repository.listArtifacts(requireNovelId(input, context)) }),
});

export const readNovelArtifactTool = createTool({
  id: "read_novel_artifact",
  description: "通过工件键分段读取已登记的 Markdown/YAML；默认最多返回 12000 字符，不能传文件路径。只读。",
  inputSchema: novelIdInput.extend({ artifactKey: z.string().min(1), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(500).max(20_000).default(12_000) }),
  outputSchema: z.object({ artifact: z.unknown(), content: z.string(), offset: z.number(), totalChars: z.number(), hasMore: z.boolean() }),
  execute: async (input, context) => {
    const result = await repository.readArtifact(requireNovelId(input, context), input.artifactKey);
    return { artifact: result.artifact, content: result.content.slice(input.offset, input.offset + input.maxChars), offset: input.offset, totalChars: result.content.length, hasMore: input.offset + input.maxChars < result.content.length };
  },
});

export const searchNovelArtifactsTool = createTool({
  id: "search_novel_artifacts",
  description: "在已提交工件正文中检索文字，返回有界片段和工件键；用于先定位再分段读取。只读。",
  inputSchema: novelIdInput.extend({ query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(12).default(6) }),
  outputSchema: z.object({ matches: z.array(z.object({ artifactKey: z.string(), excerpt: z.string() })) }),
  execute: async (input, context) => {
    const novelId = requireNovelId(input, context);
    const artifacts = await repository.listArtifacts(novelId);
    const matches: Array<{ artifactKey: string; excerpt: string }> = [];
    for (const artifact of artifacts) {
      if (!artifact.key || artifact.status !== "ready" || matches.length >= input.limit) continue;
      const content = (await repository.readArtifact(novelId, artifact.key)).content;
      const index = content.toLocaleLowerCase().indexOf(input.query.toLocaleLowerCase());
      if (index >= 0) matches.push({ artifactKey: artifact.key, excerpt: content.slice(Math.max(0, index - 180), index + input.query.length + 320) });
    }
    return { matches };
  },
});

export const readWorkspaceFileTool = createTool({
  id: "read_workspace_file",
  description: "读取当前小说 workspace/ 下的非权威工作文件；ideas.md 保存开书讨论中已确认的想法与待确认项，CREATOR.md 保存作者明确要求长期沿用的题材、尺度、文风和避雷项。文件不存在时返回 exists=false。不能读取已提交工件或 workspace 外的路径。",
  inputSchema: novelIdInput.extend({ path: z.string().trim().min(1).max(240) }),
  outputSchema: z.object({ path: z.string(), content: z.string(), sha256: z.string().optional(), exists: z.boolean() }),
  execute: async (input, context) => {
    const file = await repository.readWorkspaceFile(requireNovelId(input, context), input.path).catch((error) => {
      if (error instanceof AppError && error.code === "WORKSPACE_FILE_NOT_FOUND") return undefined;
      throw error;
    });
    return file ? { ...file, exists: true } : { path: input.path, content: "", exists: false };
  },
});

export const writeWorkspaceFileInputSchema = novelIdInput.extend({ path: z.string().trim().min(1).max(240).default("ideas.md").optional(), content: z.string().max(200_000), expectedSha256: z.string().length(64).optional() });

export const writeWorkspaceFileTool = createTool({
  id: "write_workspace_file",
  description: "创建或更新当前小说 workspace/ 下的非权威 Markdown/YAML/TXT/JSON 工作文件；path 省略时安全写入 ideas.md。开书讨论中已确认的想法与待确认项写入 ideas.md；长期沿用的题材、尺度、文风和避雷项必须显式传 path=CREATOR.md。更新已有文件前必须先读取并传 expectedSha256；不能写入权威工件目录。",
  inputSchema: writeWorkspaceFileInputSchema,
  outputSchema: z.object({ path: z.string(), sha256: z.string(), created: z.boolean() }),
  execute: async (input, context) => repository.writeWorkspaceFile(requireNovelId(input, context), input.path ?? "ideas.md", input.content, input.expectedSha256),
});

export const getChapterContextTool = createTool({
  id: "get_chapter_context",
  description: "读取指定章节计划、上一章承接、相关书级资产和连续性摘要。只读。",
  inputSchema: novelIdInput.extend({ chapter: z.number().int().positive() }),
  outputSchema: z.object({ chapter: z.number(), sources: z.array(z.object({ key: z.string(), content: z.string() })) }),
  execute: async (input, context) => {
    const novelId = requireNovelId(input, context);
    const state = await repository.get(novelId);
    const volumeOutline = isMultiVolumeProduction(state) ? `volume:${state.currentVolume}:outline` : "book:volume_outline";
    const keys = ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast", "book:volume_strategy", volumeOutline, `chapter:${input.chapter}:chapter_plan`, ...(input.chapter > 1 ? [`chapter:${input.chapter - 1}:humanization_revision`, `chapter:${input.chapter - 1}:continuity_update`] : [])];
    const sources = [];
    for (const key of keys) if (state.artifacts[key]?.status === "ready") sources.push({ key, content: (await repository.readArtifact(novelId, key)).content });
    return { chapter: input.chapter, sources };
  },
});

export const inspectContinuityTool = createTool({
  id: "inspect_continuity",
  description: "查询已登记的连续性事实、伏笔、资源和关系状态。只读。",
  inputSchema: novelIdInput.extend({ query: z.string().trim().max(200).optional() }),
  outputSchema: z.object({ entries: z.array(z.object({ key: z.string(), content: z.string() })) }),
  execute: async (input, context) => {
    const novelId = requireNovelId(input, context);
    const artifacts = await repository.listArtifacts(novelId);
    const matches = artifacts.filter((item) => item.key?.endsWith("continuity_update") && item.status === "ready").slice(-20);
    return { entries: await Promise.all(matches.map(async (item) => ({ key: item.key!, content: (await repository.readArtifact(novelId, item.key!)).content }))) };
  },
});

export const listWorkflowCapabilitiesTool = createTool({
  id: "list_workflow_capabilities",
  description: "列出全部小说 Workflow 的中文名称、适用目标、审批方式、业务说明与可观察阶段，供 Agent 推荐唯一合法下一步。只读。",
  inputSchema: z.object({}),
  outputSchema: z.object({ workflows: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), target: z.string(), approval: z.enum(["milestone", "automatic", "conditional"]), stages: z.array(z.string()) })) }),
  execute: async () => ({ workflows: Object.entries(workflowCatalog).map(([id, descriptor]) => ({ id, ...descriptor, stages: [...descriptor.stages] })) }),
});

export const startCurrentNextActionTool = createTool({
  id: "start_current_next_action",
  description: "仅当作者明确确认启动当前推荐步骤时调用。服务端会自行读取唯一合法下一步并创建对应的 Mastra Workflow Run；不能指定或跳过步骤，不能绕过开书预设确认、卷范围配置、章节授权、作者保护或活动运行检查。",
  inputSchema: z.object({}),
  outputSchema: z.object({ runId: z.string(), workflowId: z.string(), status: z.literal("running"), currentStep: z.string().optional() }),
  execute: async (input, context) => {
    const { startCurrentNextAction } = await import("../../application/workbench-service");
    const run = await startCurrentNextAction(requireNovelId(input, context));
    return { runId: run.runId, workflowId: run.workflowId!, status: "running" as const, currentStep: run.currentStep };
  },
});

export const prepareOpeningPresetTool = createTool({
  id: "prepare_opening_preset",
  description: "当作者明确说开书讨论已经说完、要求整理开书预设或希望开始开书，但当前尚未确认开书预设时调用。根据真实对话生成一份非权威、可编辑的预设提案；绝不确认作者选择或启动 Workflow。",
  inputSchema: z.object({}),
  outputSchema: openingPresetProposalSchema,
  execute: async (input, context): Promise<z.infer<typeof openingPresetProposalSchema>> => {
    const { proposeOpeningPreset } = await import("../../application/workbench-service");
    return proposeOpeningPreset(requireNovelId(input, context));
  },
});

export const presentChatChoicesTool = createTool({
  id: "present_chat_choices",
  description: "把本轮已经明确提出的有限创作方向展示为可点击选项。只允许复述作者当前可选的 2-5 个方向，不替作者做决定，不写入作品。无想法入口必须提供恰好 5 个差异明显的一句话种子。",
  inputSchema: chatChoicesSchema,
  outputSchema: chatChoicesSchema,
  execute: async (input) => input,
});

export const novelTools = {
  getNovelStatusTool,
  listNovelArtifactsTool,
  readNovelArtifactTool,
  searchNovelArtifactsTool,
  readWorkspaceFileTool,
  writeWorkspaceFileTool,
  getChapterContextTool,
  inspectContinuityTool,
  listWorkflowCapabilitiesTool,
  startCurrentNextActionTool,
  prepareOpeningPresetTool,
  presentChatChoicesTool,
};
