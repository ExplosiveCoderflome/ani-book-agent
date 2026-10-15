import {
  approvalModeSchema, availableOperations, executionEnvelopeSchema, executionStage, patchProposalSchema, productionJobSchema,
  type ApprovalMode, type PreferenceSignalInput, type ProductionInteractionMode, type ProductionJob, type ProductionJobRequest, type ProjectSnapshot,
} from "../domain";
import { AppError } from "./errors";
import { productionModelRetry } from "./production-progress";
import type { ProductionClaimOptions } from "./ports";
import type { WorkbenchDependencies } from "./workbench-dependencies";

type Dependencies = Pick<WorkbenchDependencies, "novels" | "skills" | "preferences" | "production" | "interactive" | "adaptations" | "sanitizeError">;
type StartOptions = { interactionMode?: ProductionInteractionMode; retryOf?: string; attempt?: number };
type JobAction = { action: "continue" | "revise" | "retry" | "cancel"; feedback?: string };

export function workflowTimestamp(value: unknown, fallback: string) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : fallback;
}

type ProductionErrorView = NonNullable<ProductionJob["error"]>;
const errorRecord = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
export function classifyProductionError(error: unknown, fallbackMessage = "生产任务失败，请重试。"): ProductionErrorView {
  const outer = errorRecord(error);
  const cause = errorRecord(outer.cause);
  const response = errorRecord(outer.response);
  const responseError = errorRecord(response.error);
  const status = [outer.status, outer.statusCode, response.status, cause.status, cause.statusCode].find((value) => Number.isInteger(Number(value)));
  const numericStatus = status === undefined ? undefined : Number(status);
  const code = String(outer.code ?? responseError.code ?? cause.code ?? "").toUpperCase();
  const message = [outer.message, responseError.message, cause.message, typeof error === "string" ? error : undefined].filter((value): value is string => typeof value === "string").join(" ");
  if (code === "CONTEXT_LIMIT_EXCEEDED" || /context (?:length|window)|maximum context|too many tokens|tokenlimiter|上下文.*(?:超|限制)/i.test(message)) {
    return { code: "CONTEXT_LIMIT_EXCEEDED", message: "模型上下文超过限制，请缩短输入或拆分任务后再运行。", recoverable: false };
  }
  if (numericStatus === 429 || /RATE_LIMIT|TOO_MANY_REQUESTS/.test(code) || /rate.?limit|too many requests|限流|请求过于频繁/i.test(message)) {
    return { code: "MODEL_RATE_LIMITED", message: "模型服务请求过于频繁，自动重试仍未恢复。", recoverable: true };
  }
  if (numericStatus === 408 || /MODEL_GENERATION_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code) || /timed? ?out|timeout|请求超时/i.test(message)) {
    return { code: "MODEL_TIMEOUT", message: "模型服务响应超时，自动重试仍未恢复。", recoverable: true };
  }
  if ([400, 401, 403, 404].includes(numericStatus ?? 0) || /INVALID_API_KEY|UNAUTHORIZED|FORBIDDEN|MODEL_NOT_FOUND|AUTHENTICATION/.test(code) || /invalid api key|unauthorized|forbidden|model .*not found|unknown model|authentication failed|模型不存在|密钥.*(?:错误|无效)/i.test(message)) {
    return { code: "MODEL_CONFIG_INVALID", message: "模型配置、凭据或模型名称无效，请检查模型设置。", recoverable: false };
  }
  if ((numericStatus !== undefined && numericStatus >= 500 && numericStatus <= 599) || outer.isRetryable === true || /SERVER_ERROR|OVERLOADED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/.test(code) || /socket hang up|fetch failed|connection reset|network error|temporar(?:y|ily) unavailable|服务暂时不可用/i.test(message)) {
    return { code: "MODEL_UNAVAILABLE", message: "模型服务暂时不可用，自动重试仍未恢复。", recoverable: true };
  }
  return { code: typeof outer.code === "string" && outer.code ? outer.code : "JOB_FAILED", message: fallbackMessage, recoverable: outer.recoverable !== false };
}

export function createNovelService(deps: Dependencies) {
  const starting = new Set<string>();
  const status = (value: string): ProductionJob["status"] => value === "suspended" ? "awaiting_author" : value === "success" ? "completed" : value === "failed" ? "failed" : value === "canceled" ? "canceled" : "running";
  const listNovels = () => deps.novels.list();
  const createNovel = (input: string | { title: string; approvalMode?: ApprovalMode }) => typeof input === "string"
    ? deps.novels.create(input)
    : deps.novels.create(input.title, approvalModeSchema.parse(input.approvalMode ?? "milestone"));
  const listFiles = (novelId: string) => deps.novels.listFiles(novelId);
  const readFile = (novelId: string, path: string) => deps.novels.readProjectFile(novelId, path, 0, 500_000);
  const saveAuthorFile = (novelId: string, input: { path: string; content: string; expectedSha256: string }) => deps.novels.saveAuthorFile(novelId, input.path, input.content, input.expectedSha256);
  const recallChatMessages = (novelId: string) => deps.interactive.recall(novelId);

  async function recordPreference(novelId: string, input: Omit<PreferenceSignalInput, "novelId">) {
    await deps.novels.get(novelId);
    return deps.preferences.record({ ...input, novelId });
  }
  async function chatSession(novelId: string) {
    await deps.novels.get(novelId);
    return { messages: await recallChatMessages(novelId) };
  }
  async function jobView(novelId: string, jobId: string): Promise<ProductionJob> {
    const state = await deps.production.getWorkflowRunById(jobId, { fields: ["steps", "result", "error", "payload"] });
    if (!state) throw new AppError("JOB_NOT_FOUND", "没有找到这个生产任务。", 404, false);
    const payload = (state.payload ?? {}) as Record<string, any>;
    const result = (state.result ?? {}) as Record<string, unknown>;
    if ((typeof payload.novelId === "string" && payload.novelId !== novelId) || (state.resourceId && state.resourceId !== novelId)) throw new AppError("JOB_NOVEL_MISMATCH", "生产任务不属于当前作品。", 400, false);
    const suspended = Object.values(state.steps ?? {}).map((raw: any) => Array.isArray(raw) ? raw.at(-1) : raw).find((step: any) => step?.suspendPayload)?.suspendPayload as Record<string, unknown> | undefined;
    const novel = await deps.novels.get(novelId);
    const jobStatus = status(state.status);
    const timestamp = new Date().toISOString();
    return productionJobSchema.parse({
      id: jobId, novelId, goal: payload.goal ?? "write_chapters", scope: payload.scope ?? {}, brief: payload.brief, status: jobStatus,
      interactionMode: payload.interactionMode ?? "standard", retryOf: payload.retryOf, attempt: payload.attempt ?? 1,
      cursor: typeof suspended?.chapter === "number" ? suspended.chapter : payload.goal === "write_chapters" && ["running", "failed"].includes(jobStatus) ? novel.nextChapter : undefined,
      checkpoint: suspended?.checkpoint === "curve_confirmation" ? "curve_confirmation" : suspended ? "chapter_review" : undefined,
      modelRetry: jobStatus === "running" ? productionModelRetry(jobId) : undefined,
      baseStateHash: payload.baseStateHash ?? deps.novels.stateHash(novel),
      resultPath: typeof result.reportPath === "string" ? result.reportPath : typeof result.exportPath === "string" ? result.exportPath : undefined,
      error: state.status === "failed" ? classifyProductionError(state.error, deps.sanitizeError(state.error?.message ?? "生产任务失败")) : undefined,
      createdAt: workflowTimestamp(state.createdAt, timestamp), updatedAt: workflowTimestamp(state.updatedAt, timestamp),
    });
  }
  async function projectSnapshot(novelId: string): Promise<ProjectSnapshot> {
    const [novel, files, ledger] = await Promise.all([deps.novels.get(novelId), deps.novels.listFiles(novelId), deps.novels.readLedger(novelId)]);
    // The persisted activeJobId is authoritative. If operational storage cannot
    // resolve it, fail the snapshot instead of silently unlocking a second chain.
    const activeJob = novel.activeJobId ? await jobView(novelId, novel.activeJobId) : undefined;
    return { novel, files, characterStates: ledger.characters, activeJob, availability: availableOperations(novel, activeJob) };
  }
  async function startProductionJob(novelId: string, input: ProductionJobRequest, options: StartOptions = {}): Promise<ProductionJob> {
    if (starting.has(novelId)) throw new AppError("ACTIVE_JOB", "当前作品已有生产任务。", 409, true);
    starting.add(novelId);
    let activatedJobId: string | undefined;
    try {
      const state = await deps.novels.get(novelId);
      let previousJob: ProductionClaimOptions["previousJob"];
      if (input.goal === "revise_files") throw new AppError("PATCH_REQUIRED", "文件修订请由 Agent 提交补丁；保护内容会在差异确认后应用。", 409, true, undefined, "author_approval");
      if (state.activeJobId) {
        const existing = await jobView(novelId, state.activeJobId);
        if (existing && ["queued", "running", "awaiting_author"].includes(existing.status)) throw new AppError("ACTIVE_JOB", "当前作品已有生产任务。", 409, true);
        if (existing?.status === "failed" && options.retryOf !== (existing.retryOf ?? existing.id)) throw new AppError("FAILED_JOB_REQUIRES_ACTION", "上一次生产任务尚未处理，请先选择“一键重试”或“不再重试”。", 409, true);
        previousJob = { id: state.activeJobId, status: existing.status as "failed" | "completed" | "canceled" };
      }
      if (input.goal === "write_chapters" && (state.phase !== "writing" || !state.files["book/blueprint.md"] || !state.files["book/ledger.yaml"])) throw new AppError("BLUEPRINT_INCOMPLETE", "作品蓝图或连续性账本尚未准备完整，请让 Agent 补齐后再开始写作。", 409, true, undefined, "author_approval");
      if (input.goal === "write_chapters" && !state.files["book/tension-curve.yaml"]) throw new AppError("TENSION_CURVE_REQUIRED", "这部旧作品还没有全书张力曲线。请先让 Agent 生成曲线并确认，再开始下一次卷规划或章节生产。", 409, true, undefined, "author_approval");
      const interactionMode = options.interactionMode ?? (input.goal === "write_chapters" && state.approvalMode === "autonomous_opening" ? "autonomous_opening" : "standard");
      if (interactionMode === "autonomous_opening" && (input.goal !== "write_chapters" || state.nextChapter > 3)) throw new AppError("AUTONOMOUS_OPENING_COMPLETE", "全自动开书只负责前三章，后续任务请使用普通模式。", 409, false);
      const effectiveInput: ProductionJobRequest = input.goal === "write_chapters"
        ? { ...input, scope: { ...input.scope, fromChapter: state.nextChapter, toChapter: interactionMode === "autonomous_opening" ? 3 : input.scope.toChapter ?? state.nextChapter + 2 } }
        : input;
      const [resolvedSkills, preferences, adaptationItems] = await Promise.all([
        Promise.all([deps.skills.resolveForAgent(novelId, "novel-agent"), deps.skills.resolveForAgent(novelId, "novel-critic")]),
        deps.preferences.get(),
        deps.adaptations.list(novelId),
      ]);
      const run = await deps.production.createRun({ resourceId: novelId });
      const skillVersions = Object.fromEntries(resolvedSkills.flat().map((skill) => [skill.skillId, skill.versionId]));
      const from = effectiveInput.scope.fromChapter ?? state.nextChapter;
      const to = effectiveInput.scope.toChapter ?? from + 2;
      const adaptationVersions = Object.fromEntries(adaptationItems
        .filter(({ adaptation }) => adaptation.status === "approved" && adaptation.scope.fromChapter <= to && adaptation.scope.toChapter >= from)
        .map(({ adaptation, file }) => [adaptation.id, file.sha256]));
      const createdAt = new Date().toISOString();
      const attempt = options.attempt ?? 1;
      const expectedStateHash = deps.novels.stateHash(await deps.novels.get(novelId));
      const activeState = await deps.novels.claimProductionJob(novelId, run.runId, effectiveInput, interactionMode, { expectedStateHash, previousJob });
      activatedJobId = run.runId;
      const baseStateHash = deps.novels.stateHash(activeState);
      const execution = executionEnvelopeSchema.parse({
        schemaVersion: 1, runId: run.runId, traceId: run.runId, novelId, taskType: input.goal, stage: executionStage(input.goal), novelStateHash: baseStateHash,
        preferenceVersion: preferences.version, skillVersions, adaptationVersions,
        adaptationsSha256: Object.keys(adaptationVersions).length ? deps.novels.adaptationSetHash(adaptationVersions) : undefined,
        allowedTools: [], requiresApproval: false, contextBudget: 32_000,
      });
      void run.start({ inputData: { novelId, jobId: run.runId, goal: effectiveInput.goal, scope: effectiveInput.scope, brief: effectiveInput.brief, baseStateHash, skillVersions, execution, tensionCurveRequired: true, interactionMode, retryOf: options.retryOf, attempt } })
        .then(async (result: any) => {
          const outcome = result?.status ?? result?.result?.status;
          if (["success", "completed", "failed", "canceled"].includes(outcome)) await deps.novels.finishProductionJob(novelId, run.runId, outcome === "success" ? "completed" : outcome).catch(() => undefined);
        })
        .catch(async (error) => {
          await deps.novels.finishProductionJob(novelId, run.runId, "failed").catch(() => undefined);
          console.warn("小说生产任务失败", { runId: run.runId, message: deps.sanitizeError(error) });
        });
      return productionJobSchema.parse({ id: run.runId, novelId, goal: effectiveInput.goal, scope: effectiveInput.scope, brief: effectiveInput.brief, interactionMode, retryOf: options.retryOf, attempt, status: "running", baseStateHash, createdAt, updatedAt: createdAt });
    } catch (error) {
      if (activatedJobId) await deps.novels.finishProductionJob(novelId, activatedJobId, "failed").catch(() => undefined);
      throw error;
    } finally {
      starting.delete(novelId);
    }
  }
  async function approveProposal(novelId: string, raw: unknown) {
    const proposal = patchProposalSchema.parse(raw);
    if (proposal.novelId !== novelId) throw new AppError("PROPOSAL_NOVEL_MISMATCH", "提案不属于当前作品。", 400, false);
    const applied = await deps.novels.approveProposal(proposal);
    const opened = proposal.changes.some((change) => change.path === "book/blueprint.md");
    const job = opened && !applied.duplicate ? await startProductionJob(novelId, { goal: "write_chapters", scope: { fromChapter: applied.state.nextChapter, toChapter: applied.state.nextChapter + 2 } }) : undefined;
    return { proposal: applied.proposal, novel: applied.state, job };
  }
  async function rejectProposal(novelId: string, raw: unknown) {
    const proposal = patchProposalSchema.parse(raw);
    if (proposal.novelId !== novelId) throw new AppError("PROPOSAL_NOVEL_MISMATCH", "提案不属于当前作品。", 400, false);
    return deps.novels.rejectProposal(proposal);
  }
  async function resumeJob(novelId: string, jobId: string, input: JobAction) {
    const current = await jobView(novelId, jobId);
    if (input.action === "retry") {
      if (current.status !== "failed") throw new AppError("JOB_NOT_FAILED", "只有失败的任务可以重试。", 409, true);
      const state = await deps.novels.get(novelId);
      const scope = current.goal === "write_chapters"
        ? { ...current.scope, fromChapter: state.nextChapter, toChapter: current.scope.toChapter }
        : current.scope;
      if (current.goal === "write_chapters" && scope.toChapter !== undefined && state.nextChapter > scope.toChapter) throw new AppError("JOB_ALREADY_COMPLETE", "原任务的章节范围已经完成，无需重试。", 409, false);
      return startProductionJob(novelId, { goal: current.goal, scope, brief: current.brief }, { interactionMode: current.interactionMode, retryOf: current.retryOf ?? current.id, attempt: current.attempt + 1 });
    }
    const run = await deps.production.createRun({ runId: jobId, resourceId: novelId });
    if (input.action === "cancel") {
      await deps.novels.finishProductionJob(novelId, jobId, "canceled");
      if (["queued", "running", "awaiting_author"].includes(current.status)) await run.cancel();
      return { ...current, status: "canceled" as const };
    }
    if (current.status !== "awaiting_author") throw new AppError("JOB_NOT_SUSPENDED", "当前任务不在等待作者处理状态。", 409, true);
    if (current.checkpoint !== "curve_confirmation") throw new AppError("JOB_RESTART_REQUIRED", "此任务使用旧的确认流程，请取消后重新启动。", 409, true);
    await deps.novels.confirmProductionPlan(novelId, jobId);
    void run.resume({ step: "run-production", resumeData: input })
      .then(async (result) => {
        if (["success", "failed", "canceled"].includes(result.status)) await deps.novels.finishProductionJob(novelId, jobId, result.status === "success" ? "completed" : result.status as "failed" | "canceled").catch(() => undefined);
      })
      .catch(async (error) => {
        await deps.novels.finishProductionJob(novelId, jobId, "failed").catch(() => undefined);
        console.warn("恢复生产任务失败", { jobId, message: deps.sanitizeError(error) });
      });
    return { ...current, status: "running" as const, updatedAt: new Date().toISOString() };
  }
  async function cancelAutoOpening(novelId: string) {
    const state = await deps.novels.get(novelId);
    if (state.approvalMode !== "autonomous_opening") return { novel: state };
    if (state.activeJobId) await resumeJob(novelId, state.activeJobId, { action: "cancel" });
    return { novel: await deps.novels.cancelAutonomousOpening(novelId) };
  }
  return { listNovels, createNovel, listFiles, readFile, saveAuthorFile, recordPreference, recallChatMessages, chatSession, jobView, projectSnapshot, startProductionJob, approveProposal, rejectProposal, resumeJob, cancelAutoOpening };
}
