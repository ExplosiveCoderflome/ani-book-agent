import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { decideNextAction, workflowIds } from "../../domain";
import { NovelRepository } from "../../infrastructure/novel-repository";

const repository = new NovelRepository();
const novelIdInput = z.object({ novelId: z.string().uuid().optional() });

function requireNovelId(input: { novelId?: string }, context: { requestContext: { get(key: string): unknown } }) {
  const novelId = input.novelId ?? context.requestContext.get("novelId");
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
  description: "通过工件键读取小说内已登记的 Markdown/YAML；不能传文件路径。只读。",
  inputSchema: novelIdInput.extend({ artifactKey: z.string().min(1) }),
  outputSchema: z.object({ artifact: z.unknown(), content: z.string() }),
  execute: async (input, context) => repository.readArtifact(requireNovelId(input, context), input.artifactKey),
});

export const getChapterContextTool = createTool({
  id: "get_chapter_context",
  description: "读取指定章节计划、上一章承接、相关书级资产和连续性摘要。只读。",
  inputSchema: novelIdInput.extend({ chapter: z.number().int().positive() }),
  outputSchema: z.object({ chapter: z.number(), sources: z.array(z.object({ key: z.string(), content: z.string() })) }),
  execute: async (input, context) => {
    const novelId = requireNovelId(input, context);
    const state = await repository.get(novelId);
    const keys = ["book:novel_brief", "book:story_bible", "book:world_bible", "book:character_cast", "book:volume_strategy", "book:volume_outline", `chapter:${input.chapter}:chapter_plan`, ...(input.chapter > 1 ? [`chapter:${input.chapter - 1}:humanization_revision`, `chapter:${input.chapter - 1}:continuity_update`] : [])];
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
  description: "列出可推荐的小说 Workflow 及其目标要求。只读。",
  inputSchema: z.object({}),
  outputSchema: z.object({ workflows: z.array(z.object({ id: z.string(), target: z.string() })) }),
  execute: async () => ({ workflows: workflowIds.map((id) => ({ id, target: id.includes("chapter") || id === "quality-repair" ? "章节号或章节范围" : id === "novel-export" ? "可选导出文件名" : "当前作品" })) }),
});

export const novelTools = {
  getNovelStatusTool,
  listNovelArtifactsTool,
  readNovelArtifactTool,
  getChapterContextTool,
  inspectContinuityTool,
  listWorkflowCapabilitiesTool,
};
