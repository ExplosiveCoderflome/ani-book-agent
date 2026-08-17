import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { patchProposalSchema, productionJobSchema, type PatchProposal, type ProductionJob, type ProductionJobRequest } from "../domain";
import { NovelRepository, novelStateHash } from "../infrastructure/novel-repository";
import { loadProviderCatalog } from "../infrastructure/provider-catalog";
import { modelSettings, sanitizeProviderError } from "../infrastructure/model-settings";
import { novelAgent } from "../mastra/agents/novel-agent";
import { structuredOutputOptions } from "../mastra/structured-output";
import { novelProductionWorkflow } from "../mastra/workflows/novel-production-workflow";
import type { ProjectSnapshot } from "../shared/contracts";
import { AppError } from "./errors";
import { skillRegistry } from "./skill-service";

export const novelRepository = new NovelRepository();
const starting = new Set<string>();

export async function bootstrap() { const [models, novels] = await Promise.all([modelSettings.status(), novelRepository.list()]); return { models, novels, service: { studio: "ready", workbench: "ready" } }; }
export async function providers() { const status = await modelSettings.status(); return loadProviderCatalog(new Set(status.configuredProviders)); }
export async function listNovels() { return novelRepository.list(); }
export async function createNovel(title: string) { return novelRepository.create(title); }
export async function listFiles(novelId: string) { return novelRepository.listFiles(novelId); }
export async function readFile(novelId: string, path: string) { return novelRepository.readProjectFile(novelId, path, 0, 500_000); }
export async function saveAuthorFile(novelId: string, input: { path: string; content: string; expectedSha256: string }) { return novelRepository.saveAuthorFile(novelId, input.path, input.content, input.expectedSha256); }

export async function recallChatMessages(novelId: string) {
  const memory = await novelAgent.getMemory();
  if (!memory) return [];
  const thread = await memory.getThreadById({ threadId: novelId });
  return thread ? (await memory.recall({ threadId: novelId, resourceId: novelId, perPage: 100, page: 0 })).messages : [];
}
export async function chatSession(novelId: string) { await novelRepository.get(novelId); return { messages: await recallChatMessages(novelId) }; }

function status(value: string): ProductionJob["status"] {
  return value === "suspended" ? "awaiting_author" : value === "success" ? "completed" : value === "failed" ? "failed" : value === "canceled" ? "canceled" : "running";
}
export async function jobView(novelId: string, jobId: string): Promise<ProductionJob> {
  const state = await novelProductionWorkflow.getWorkflowRunById(jobId, { fields: ["steps", "result", "error", "payload"] });
  if (!state) throw new AppError("JOB_NOT_FOUND", "没有找到这个生产任务。", 404, false);
  const payload = (state.payload ?? {}) as Record<string, any>;
  const result = (state.result ?? {}) as Record<string, unknown>;
  if ((typeof payload.novelId === "string" && payload.novelId !== novelId) || (state.resourceId && state.resourceId !== novelId)) throw new AppError("JOB_NOVEL_MISMATCH", "生产任务不属于当前作品。", 400, false);
  const steps = Object.entries(state.steps ?? {}) as Array<[string, any]>;
  const suspended = steps.map(([, raw]) => Array.isArray(raw) ? raw.at(-1) : raw).find((step) => step?.suspendPayload)?.suspendPayload as Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  return productionJobSchema.parse({
    id: jobId, novelId, goal: payload.goal ?? "write_chapters", scope: payload.scope ?? {}, brief: payload.brief, status: status(state.status),
    cursor: typeof suspended?.chapter === "number" ? suspended.chapter : undefined, baseStateHash: payload.baseStateHash ?? novelStateHash(await novelRepository.get(novelId)),
    resultPath: typeof result.reportPath === "string" ? result.reportPath : typeof result.exportPath === "string" ? result.exportPath : undefined,
    error: state.status === "failed" ? { code: "JOB_FAILED", message: sanitizeProviderError(state.error?.message ?? "生产任务失败"), recoverable: true } : undefined,
    createdAt: typeof state.createdAt === "string" ? state.createdAt : now, updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : now,
  });
}

export async function projectSnapshot(novelId: string): Promise<ProjectSnapshot> {
  const [novel, files] = await Promise.all([novelRepository.get(novelId), novelRepository.listFiles(novelId)]);
  const activeJob = novel.activeJobId ? await jobView(novelId, novel.activeJobId).catch(() => undefined) : undefined;
  const { availableOperations } = await import("../domain");
  return { novel, files, activeJob, availability: availableOperations(novel, activeJob) };
}

export async function startProductionJob(novelId: string, input: ProductionJobRequest): Promise<ProductionJob> {
  if (starting.has(novelId)) throw new AppError("ACTIVE_JOB", "当前作品已有生产任务。", 409, true);
  starting.add(novelId);
  try {
    const state = await novelRepository.get(novelId);
    if (input.goal === "revise_files") throw new AppError("PATCH_REQUIRED", "文件修订请由 Agent 提交补丁；保护内容会在差异确认后应用。", 409, true, undefined, "author_approval");
    if (state.activeJobId) {
      const existing = await jobView(novelId, state.activeJobId).catch(() => undefined);
      if (existing && ["queued", "running", "awaiting_author"].includes(existing.status)) throw new AppError("ACTIVE_JOB", "当前作品已有生产任务。", 409, true);
      await novelRepository.setActiveJob(novelId, undefined);
    }
    if (input.goal === "write_chapters" && (state.phase !== "writing" || !state.files["book/blueprint.md"] || !state.files["book/ledger.yaml"])) throw new AppError("BLUEPRINT_INCOMPLETE", "作品蓝图或连续性账本尚未准备完整，请让 Agent 补齐后再开始写作。", 409, true, undefined, "author_approval");
    const run = await novelProductionWorkflow.createRun({ resourceId: novelId });
    const skillVersions = Object.fromEntries((await Promise.all([
      skillRegistry.resolveForAgent(novelId, "novel-agent"), skillRegistry.resolveForAgent(novelId, "novel-critic"),
    ])).flat().map((skill) => [skill.skillId, skill.versionId]));
    const createdAt = new Date().toISOString();
    const activeState = await novelRepository.setActiveJob(novelId, run.runId);
    const baseStateHash = novelStateHash(activeState);
    void run.start({ inputData: { novelId, jobId: run.runId, goal: input.goal, scope: input.scope, brief: input.brief, baseStateHash, skillVersions } })
      .catch((error) => { console.warn("小说生产任务失败", { runId: run.runId, message: sanitizeProviderError(error) }); });
    return productionJobSchema.parse({ id: run.runId, novelId, goal: input.goal, scope: input.scope, brief: input.brief, status: "running", baseStateHash, createdAt, updatedAt: createdAt });
  } finally { starting.delete(novelId); }
}

export async function approveProposal(novelId: string, raw: unknown) {
  const proposal = patchProposalSchema.parse(raw);
  if (proposal.novelId !== novelId) throw new AppError("PROPOSAL_NOVEL_MISMATCH", "提案不属于当前作品。", 400, false);
  if (proposal.status !== "pending") throw new AppError("PROPOSAL_NOT_PENDING", "这个提案已经处理过。", 409, false);
  const applied = await novelRepository.applyProposal(proposal, true);
  const opened = proposal.changes.some((change) => change.path === "book/blueprint.md");
  const job = opened && !applied.duplicate ? await startProductionJob(novelId, { goal: "write_chapters", scope: { fromChapter: applied.state.nextChapter, toChapter: applied.state.nextChapter + 2 } }) : undefined;
  return { proposal: applied.proposal, novel: applied.state, job };
}
export function rejectProposal(novelId: string, raw: unknown) { const proposal = patchProposalSchema.parse(raw); if (proposal.novelId !== novelId) throw new AppError("PROPOSAL_NOVEL_MISMATCH", "提案不属于当前作品。", 400, false); return { ...proposal, status: "rejected" as const }; }

export async function resumeJob(novelId: string, jobId: string, input: { action: "continue" | "revise" | "cancel"; feedback?: string }) {
  const current = await jobView(novelId, jobId);
  const run = await novelProductionWorkflow.createRun({ runId: jobId, resourceId: novelId });
  if (input.action === "cancel") { await run.cancel(); await novelRepository.setActiveJob(novelId, undefined); return { ...current, status: "canceled" as const }; }
  if (current.status !== "awaiting_author") throw new AppError("JOB_NOT_SUSPENDED", "当前任务不在等待作者处理状态。", 409, true);
  void run.resume({ step: "run-production", resumeData: input })
    .then(async (result) => { if (["failed", "canceled"].includes(result.status)) await novelRepository.clearActiveJob(novelId, jobId).catch(() => undefined); })
    .catch((error) => { console.warn("恢复生产任务失败", { jobId, message: sanitizeProviderError(error) }); });
  return { ...current, status: "running" as const, updatedAt: new Date().toISOString() };
}

export async function testModelConnection() {
  const selection = await modelSettings.runtimeSelection("chat"); const started = performance.now();
  try { const schema = z.object({ ok: z.literal(true) }); const context = new RequestContext([["modelProfile", "chat"]]); const result = await novelAgent.generate("连接测试，只返回 ok=true。", { requestContext: context, ...structuredOutputOptions(schema) }); schema.parse(result.object); return { ok: true, latencyMs: Math.round(performance.now() - started), model: selection.model }; }
  catch (error) { throw new AppError("MODEL_CONNECTION_FAILED", `连接测试失败：${sanitizeProviderError(error)}`, 502, true); }
}

export async function testSkillDraft(skillId: string, prompt: string) {
  const { record, version } = await skillRegistry.get(skillId, true);
  const readableFiles = version.files.filter((file) => file.kind === "text" && (file.path === "SKILL.md" || file.path.startsWith("references/")));
  const entry = readableFiles.find((file) => file.path === "SKILL.md");
  if (!entry?.content) throw new AppError("SKILL_ENTRY_MISSING", "Skill 没有可测试的 SKILL.md。", 400, true);
  const started = performance.now();
  const context = new RequestContext([["taskType", "skill-test"], ["modelProfile", "chat"]]);
  const resourceContext = readableFiles.map((file) => `\n\n--- ${file.path} ---\n${file.content ?? ""}`).join("").slice(0, 120_000);
  const result = await novelAgent.generate(`${resourceContext}\n\n测试任务：\n${prompt}\n\n这是隔离试运行，不读取或修改任何真实作品，只展示这个 Skill 会如何处理任务。不得调用工具、写入文件或提交提案。`, { requestContext: context, toolChoice: "none", modelSettings: { maxOutputTokens: 2_000 } });
  return { skillId, versionId: version.id, output: result.text?.trim() ?? "", elapsedMs: Math.round(performance.now() - started), usedFiles: readableFiles.map((file) => file.path), scriptExecution: record.requiresSandbox ? "disabled" as const : "not_required" as const, traceId: result.traceId };
}
