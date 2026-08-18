import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { AppError } from "../../application/errors";
import { novelStateSchema, patchChangeSchema, patchProposalSchema, productionJobRequestSchema, productionJobSchema } from "../../domain";
import { NovelRepository } from "../../infrastructure/novel-repository";
import { readSkill } from "../skill-loader";
import { skillRegistry } from "../../application/skill-service";
import { ReferenceRepository } from "../../infrastructure/reference-repository";

const repository = new NovelRepository();
const references = new ReferenceRepository();
const errorSchema = z.object({ code: z.string(), message: z.string(), recoverable: z.boolean(), nextAction: z.enum(["retry", "reread", "author_approval", "replan"]).optional() });
const failedSchema = z.object({ ok: z.literal(false), error: errorSchema });
function novelId(context: { requestContext: { get(key: string): unknown } }) { return z.string().uuid().parse(context.requestContext.get("novelId")); }
function failure(error: unknown) {
  if (error instanceof AppError) return { ok: false as const, error: { code: error.code, message: error.message, recoverable: error.recoverable, ...(error.nextAction ? { nextAction: error.nextAction } : {}) } };
  return { ok: false as const, error: { code: "TOOL_FAILED", message: error instanceof Error ? error.message : "工具执行失败。", recoverable: true, nextAction: "retry" as const } };
}

export const readProjectTool = createTool({
  id: "read_project",
  description: "读取当前小说状态、文件清单和指定文件片段。需要作品事实时先使用；不会修改任何内容。",
  inputSchema: z.object({ paths: z.array(z.object({ path: z.string(), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(500).max(40_000).default(12_000) })).max(8).default([]) }),
  outputSchema: z.union([z.object({ ok: z.literal(true), novel: novelStateSchema, files: z.array(z.object({ path: z.string(), sha256: z.string(), source: z.string(), protected: z.boolean(), size: z.number() })), contents: z.array(z.object({ path: z.string(), sha256: z.string(), content: z.string() })) }), failedSchema]),
  execute: async (input, context) => { try {
    const id = novelId(context); const [novel, files, contents] = await Promise.all([repository.get(id), repository.listFiles(id), Promise.all(input.paths.map((item) => repository.readProjectFile(id, item.path, item.offset, item.maxChars)))]);
    return { ok: true as const, novel, files: files.map(({ path, sha256, source, protected: locked, size }) => ({ path, sha256, source, protected: locked, size })), contents: contents.map(({ path, sha256, content }) => ({ path, sha256, content })) };
  } catch (error) { return failure(error); } },
});

export const searchProjectTool = createTool({
  id: "search_project",
  description: "在当前小说蓝图、账本、卷计划和章节中搜索文字，返回有界片段。",
  inputSchema: z.object({ query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(12).default(8) }),
  outputSchema: z.union([z.object({ ok: z.literal(true), matches: z.array(z.object({ path: z.string(), excerpt: z.string() })) }), failedSchema]),
  execute: async (input, context) => { try { return { ok: true as const, matches: await repository.search(novelId(context), input.query, input.limit) }; } catch (error) { return failure(error); } },
});

export const readSkillTool = createTool({
  id: "read_skill",
  description: "兼容入口：按名称读取当前作品允许使用的已发布创作方法。优先使用 Workspace 的 skill_search 与 skill_read。",
  inputSchema: z.object({ id: z.string().trim().min(1).max(120) }),
  outputSchema: z.union([z.object({ ok: z.literal(true), id: z.string(), content: z.string() }), failedSchema]),
  execute: async (input, context) => { try {
    const id = novelId(context); const taskType = context.requestContext.get("taskType");
    const allowed = await skillRegistry.resolveForAgent(id, "novel-agent", typeof taskType === "string" ? taskType : undefined);
    const selected = allowed.find((item) => item.skillId === input.id || item.name === input.id);
    if (!selected) throw new AppError("SKILL_NOT_ALLOWED", "当前作品没有启用这个创作方法。", 403, true, undefined, "reread");
    return { ok: true as const, id: selected.skillId, content: await readSkill(selected.skillId, selected.versionId) };
  } catch (error) { return failure(error); } },
});

export const readReferenceTool = createTool({
  id: "read_reference",
  description: "读取已完成的全局拆书报告、阶段或章节分析，用于把抽象方法应用到当前作品。只读且有界；不得将参考书专有事实写入当前作品账本。",
  inputSchema: z.object({ referenceId: z.string().uuid(), analysisId: z.string(), kind: z.enum(["report", "segment", "chapter"]), id: z.string().max(120).optional() }),
  outputSchema: z.union([z.object({ ok: z.literal(true), referenceId: z.string(), analysisId: z.string(), kind: z.string(), content: z.string() }), failedSchema]),
  execute: async (input) => { try {
    const state = await references.get(input.referenceId); const analysis = state.analyses.find((item) => item.id === input.analysisId && item.status === "completed"); if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到已完成的拆书结果。", 404, true, undefined, "reread");
    const relative = input.kind === "report" ? analysis.reportPath ?? "report.md" : input.kind === "segment" ? `segments/${input.id}.yaml` : `chapters/${input.id}.yaml`;
    return { ok: true as const, referenceId: input.referenceId, analysisId: input.analysisId, kind: input.kind, content: await references.readAnalysisFile(input.referenceId, input.analysisId, relative, 40_000) };
  } catch (error) { return failure(error); } },
});

export const proposePatchTool = createTool({
  id: "propose_patch",
  description: "提交权威作品文件的创建或替换提案。替换前必须 read_project 并传 baseSha256；工具只校验或应用，不调用模型。",
  inputSchema: z.object({ intent: z.string().min(1).max(500), summary: z.string().min(1).max(1_000), changes: z.array(patchChangeSchema).min(1).max(20) }),
  outputSchema: z.union([z.object({ ok: z.literal(true), proposal: patchProposalSchema }), failedSchema]),
  execute: async (input, context) => { try {
    const proposal = await repository.prepareProposal(novelId(context), input);
    if (proposal.approval === "auto") return { ok: true as const, proposal: (await repository.applyProposal(proposal, false)).proposal };
    return { ok: true as const, proposal };
  } catch (error) { return failure(error); } },
});

export const startJobTool = createTool({
  id: "start_job",
  description: "仅在作者明确要求时启动合法后台任务。review_project 是通用审查原语：由你用 brief 描述目标并用 scope 选择文件或章节，不要为不同审查主题寻找专用工具。每本小说同时只允许一个任务。",
  inputSchema: productionJobRequestSchema,
  outputSchema: z.union([z.object({ ok: z.literal(true), job: productionJobSchema }), failedSchema]),
  execute: async (input, context) => { try { const { startProductionJob } = await import("../../application/workbench-service"); return { ok: true as const, job: await startProductionJob(novelId(context), input) }; } catch (error) { return failure(error); } },
});

export const projectTools = {
  read_project: readProjectTool,
  search_project: searchProjectTool,
  read_skill: readSkillTool,
  read_reference: readReferenceTool,
  propose_patch: proposePatchTool,
  start_job: startJobTool,
};
