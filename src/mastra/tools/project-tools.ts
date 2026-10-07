import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { AppError } from "../../application/errors";
import type { NovelProjectStore, ReferenceLibraryStore, SkillCatalogPort } from "../../application/ports";
import { novelStateSchema, patchChangeSchema, patchProposalSchema, productionJobRequestSchema, productionJobSchema, type ProductionJob, type ProductionJobRequest } from "../../domain";

const errorSchema = z.object({ code: z.string(), message: z.string(), recoverable: z.boolean(), nextAction: z.enum(["retry", "reread", "author_approval", "replan"]).optional() });
const failedSchema = z.object({ ok: z.literal(false), error: errorSchema });
function novelId(context: { requestContext: { get(key: string): unknown } }) { return z.string().uuid().parse(context.requestContext.get("novelId")); }
function failure(error: unknown) {
  if (error instanceof AppError) return { ok: false as const, error: { code: error.code, message: error.message, recoverable: error.recoverable, ...(error.nextAction ? { nextAction: error.nextAction } : {}) } };
  return { ok: false as const, error: { code: "TOOL_FAILED", message: error instanceof Error ? error.message : "工具执行失败。", recoverable: true, nextAction: "retry" as const } };
}

export const projectToolIds = ["read_project", "search_project", "read_skill", "read_reference", "propose_patch", "start_job"] as const;

export function selectProjectReadPaths(requested: Array<{ path: string; offset: number; maxChars: number }>, availablePaths: string[]) {
  const available = new Set(availablePaths);
  return {
    readable: requested.filter((item) => available.has(item.path)),
    skipped: requested.filter((item) => !available.has(item.path)).map((item) => ({ path: item.path, reason: "路径不在当前文件清单中；目录和尚未创建的文件不能读取。" })),
  };
}

export function createProjectTools(deps: {
  novels: NovelProjectStore;
  references: ReferenceLibraryStore;
  skills: SkillCatalogPort;
  readSkill(id: string, versionId?: string): Promise<string>;
  startProductionJob(novelId: string, input: ProductionJobRequest): Promise<ProductionJob>;
}) {
  const readProjectTool = createTool({
    id: "read_project", description: "读取当前小说状态、文件清单和已存在的精确文件。首次检查状态时 paths 传空数组；只能从返回的 files 清单选择精确路径，绝不传 book、chapters 等目录或猜测尚未创建的文件。不会修改内容。",
    inputSchema: z.object({ paths: z.array(z.object({ path: z.string().describe("必须来自 read_project 返回的 files 清单，不能是目录或猜测路径"), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(500).max(40_000).default(12_000) })).max(8).default([]).describe("留空只读取项目状态和完整文件清单") }),
    outputSchema: z.union([z.object({ ok: z.literal(true), novel: novelStateSchema, files: z.array(z.object({ path: z.string(), sha256: z.string(), source: z.string(), protected: z.boolean(), size: z.number() })), contents: z.array(z.object({ path: z.string(), sha256: z.string(), content: z.string() })), skipped: z.array(z.object({ path: z.string(), reason: z.string() })) }), failedSchema]),
    execute: async (input, context) => { try {
      const id = novelId(context); const [novel, files] = await Promise.all([deps.novels.get(id), deps.novels.listFiles(id)]);
      const selection = selectProjectReadPaths(input.paths, files.map((file) => file.path));
      const contents = await Promise.all(selection.readable.map((item) => deps.novels.readProjectFile(id, item.path, item.offset, item.maxChars)));
      return { ok: true as const, novel, files: files.map(({ path, sha256, source, protected: locked, size }) => ({ path, sha256, source, protected: locked, size })), contents: contents.map(({ path, sha256, content }) => ({ path, sha256, content })), skipped: selection.skipped };
    } catch (error) { return failure(error); } },
  });

  const searchProjectTool = createTool({
    id: "search_project", description: "在当前小说蓝图、账本、卷计划和章节中搜索文字，返回有界片段。",
    inputSchema: z.object({ query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(12).default(8) }),
    outputSchema: z.union([z.object({ ok: z.literal(true), matches: z.array(z.object({ path: z.string(), excerpt: z.string() })) }), failedSchema]),
    execute: async (input, context) => { try { return { ok: true as const, matches: await deps.novels.search(novelId(context), input.query, input.limit) }; } catch (error) { return failure(error); } },
  });

  const readSkillTool = createTool({
    id: "read_skill", description: "兼容入口：按名称读取当前作品允许使用的已发布创作方法。优先使用 Workspace 的 skill_search 与 skill_read。",
    inputSchema: z.object({ id: z.string().trim().min(1).max(120) }),
    outputSchema: z.union([z.object({ ok: z.literal(true), id: z.string(), content: z.string() }), failedSchema]),
    execute: async (input, context) => { try {
      const id = novelId(context); const taskType = context.requestContext.get("taskType");
      const allowed = await deps.skills.resolveForAgent(id, "novel-agent", typeof taskType === "string" ? taskType : undefined);
      const selected = allowed.find((item) => item.skillId === input.id || item.name === input.id);
      if (!selected) throw new AppError("SKILL_NOT_ALLOWED", "当前作品没有启用这个创作方法。", 403, true, undefined, "reread");
      return { ok: true as const, id: selected.skillId, content: await deps.readSkill(selected.skillId, selected.versionId) };
    } catch (error) { return failure(error); } },
  });

  const readReferenceTool = createTool({
    id: "read_reference", description: "按精确 ID 读取已完成拆书结果中的小节、洞察、角色档案、阶段或章节分析。只读且有界；不得将参考书专有事实写入当前作品账本。",
    inputSchema: z.object({ referenceId: z.string().uuid(), analysisId: z.string(), kind: z.enum(["section", "insight", "character", "segment", "chapter"]), id: z.string().min(1).max(240) }),
    outputSchema: z.union([z.object({ ok: z.literal(true), referenceId: z.string(), analysisId: z.string(), kind: z.string(), content: z.string() }), failedSchema]),
    execute: async (input) => { try {
      const state = await deps.references.get(input.referenceId); const analysis = state.analyses.find((item) => item.id === input.analysisId && item.status === "completed");
      if (!analysis) throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到已完成的拆书结果。", 404, true, undefined, "reread");
      if (input.kind === "insight") {
        const insight = (await deps.references.sections(input.referenceId, input.analysisId)).flatMap((section) => section.insights).find((item) => item.id === input.id);
        if (!insight) throw new AppError("REFERENCE_INSIGHT_NOT_FOUND", "没有找到这条拆书洞察。", 404, true, undefined, "reread");
        const { evidence: _evidence, ...mechanism } = insight;
        return { ok: true as const, referenceId: input.referenceId, analysisId: input.analysisId, kind: input.kind, content: JSON.stringify(mechanism) };
      }
      const relative = input.kind === "section" ? `sections/${input.id}.yaml` : input.kind === "character" ? `characters/${encodeURIComponent(input.id)}.yaml` : input.kind === "segment" ? `segments/${input.id}.yaml` : `chapters/${input.id}.yaml`;
      return { ok: true as const, referenceId: input.referenceId, analysisId: input.analysisId, kind: input.kind, content: await deps.references.readAnalysisFile(input.referenceId, input.analysisId, relative, 40_000) };
    } catch (error) { return failure(error); } },
  });

  const proposePatchTool = createTool({
    id: "propose_patch", description: "提交权威作品文件的创建或替换提案。替换前必须 read_project 并传 baseSha256；全自动开书的完整资产会直接应用并启动前三章任务。",
    inputSchema: z.object({ intent: z.string().min(1).max(500), summary: z.string().min(1).max(1_000), changes: z.array(patchChangeSchema).min(1).max(20) }),
    outputSchema: z.union([z.object({ ok: z.literal(true), proposal: patchProposalSchema, job: productionJobSchema.optional() }), failedSchema]),
    execute: async (input, context) => { try {
      const id = novelId(context);
      const proposal = await deps.novels.prepareProposal(id, input);
      if (proposal.approval === "auto") {
        const applied = await deps.novels.applyProposal(proposal, false);
        if (!applied.duplicate && proposal.changes.some((change) => change.path === "book/blueprint.md")) {
          try {
            const job = await deps.startProductionJob(id, { goal: "write_chapters", scope: { fromChapter: applied.state.nextChapter, toChapter: 3 } });
            return { ok: true as const, proposal: applied.proposal, job };
          } catch (error) {
            const failed = failure(error);
            return { ok: false as const, error: { ...failed.error, code: "AUTO_OPENING_START_FAILED", message: `开书资产已经保存，但前三章任务没有启动：${failed.error.message}`, recoverable: true, nextAction: "retry" as const } };
          }
        }
        return { ok: true as const, proposal: applied.proposal };
      }
      return { ok: true as const, proposal };
    } catch (error) { return failure(error); } },
  });

  const startJobTool = createTool({
    id: "start_job", description: "仅在作者明确要求时启动合法后台任务。write_chapters 会在自动写作、验收和有限修复通过后直接提交章节与连续性，不需要先在聊天中预览正文或二次确认写入；review_project 是通用审查原语；每本小说同时只允许一个任务。",
    inputSchema: productionJobRequestSchema,
    outputSchema: z.union([z.object({ ok: z.literal(true), job: productionJobSchema }), failedSchema]),
    execute: async (input, context) => { try { return { ok: true as const, job: await deps.startProductionJob(novelId(context), input) }; } catch (error) { return failure(error); } },
  });

  return { read_project: readProjectTool, search_project: searchProjectTool, read_skill: readSkillTool, read_reference: readReferenceTool, propose_patch: proposePatchTool, start_job: startJobTool };
}
