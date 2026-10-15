import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import {
  characterProfileContentSchema, criticResultSchema, isAutonomousOpeningBundle, ledgerSchema, mergeLedger, newNovelState,
  normalizeNovelPath, novelStateSchema, patchApproval, patchProposalSchema, productionAuthorizationSchema, productionJobRequestSchema,
  type ApprovalMode, type CriticResult, type NovelState, type PatchProposal, type ProductionInteractionMode, type ProductionJobRequest,
} from "./project";
import { referenceAdaptationSchema, transitionAdaptation, type ReferenceAdaptation } from "./reference-adaptation";
import { skillBindingsSchema, type SkillBindings } from "./skill";
import {
  actualTensionCurveSchema, actualTensionPath, bookTensionCurveSchema, diagnoseTension, isTargetTensionCurvePath,
  isTensionCurvePath, lockedPointChanges, markAuthorEdits, targetTensionCurveSchema, tensionCurveAssetSchema, volumeTensionCurveSchema, volumeTensionPath,
} from "./tension-curve";

export const contentHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const stateHash = (state: NovelState) => contentHash(JSON.stringify(canonical(state)));
const yaml = (value: unknown) => stringify(value, { lineWidth: 0 });
export const proposalPath = (id: string) => `workspace/proposals/${id}.yaml`;
const adaptationPath = (id: string) => `workspace/references/adaptations/${id}.yaml`;
export const volumePlanPath = (volume: number) => `volumes/volume-${String(volume).padStart(3, "0")}.md`;
const chapterPath = (chapter: number) => `chapters/chapter-${String(chapter).padStart(3, "0")}.md`;
const reviewPath = (jobId: string) => `workspace/reviews/review-${contentHash(jobId).slice(0, 24)}.md`;
const exportPath = (title: string) => `exports/${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 80) || "novel"}.txt`;
const internalPath = (path: string) => /^(?:workspace\/(?:proposals|analysis|reviews)\/|workspace\/references\/adaptations\/)/.test(path.toLowerCase());
const protectedFile = (state: NovelState, path: string) => state.files[path]?.protected || state.files[path]?.source === "author";
export function adaptationAuthorityHashes(state: NovelState) {
  return Object.fromEntries(Object.entries(state.files).filter(([path]) => ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"].includes(path) || /^volumes\/volume-\d{3}(?:-tension)?\.(?:md|yaml)$/.test(path)).map(([path, record]) => [path, record.sha256]));
}

export class NovelPolicyError extends Error {
  constructor(public readonly code: string, message: string, public readonly nextAction: "retry" | "reread" | "author_approval" | "replan" = "reread", public readonly recoverable = true) { super(message); }
}
function fail(code: string, message: string, action?: NovelPolicyError["nextAction"]): never { throw new NovelPolicyError(code, message, action); }
function validPath(value: string) { try { return normalizeNovelPath(value); } catch { return fail("INVALID_NOVEL_PATH", "作品文件路径无效。"); } }
function contract<T>(code: string, label: string, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof NovelPolicyError) throw error;
    const detail = error instanceof ZodError ? error.issues.slice(0, 4).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；") : error instanceof Error ? error.message : "无法解析";
    return fail(code, `${label}：${detail}`, "retry");
  }
}

export type ChapterCommitInput = { jobId: string; chapter: number; text: string; review: CriticResult; basis: Record<string, string> };
export type ClaimOptions = { expectedStateHash?: string; previousJob?: { id: string; status: "failed" | "completed" | "canceled" } };
export type NovelCommand =
  | { type: "create"; novelId: string; title: string; approvalMode: ApprovalMode }
  | { type: "observe_external"; path: string; content: string }
  | { type: "prepare_proposal"; proposal: PatchProposal }
  | { type: "apply_proposal" | "approve_proposal" | "reject_proposal"; proposal: PatchProposal }
  | { type: "author_edit"; path: string; content: string; expectedSha256: string }
  | { type: "initialize_bindings"; bindings: SkillBindings }
  | { type: "create_adaptation"; adaptation: ReferenceAdaptation }
  | { type: "transition_adaptation"; adaptationId: string; action: "approve" | "reject" }
  | { type: "stale_adaptation"; adaptationId: string; reasons: ReferenceAdaptation["staleReasons"] }
  | { type: "claim_job"; jobId: string; request: ProductionJobRequest; interactionMode: ProductionInteractionMode; options?: ClaimOptions }
  | { type: "finish_job"; jobId: string; outcome: "completed" | "failed" | "canceled" }
  | { type: "cancel_autonomous_opening" }
  | { type: "commit_plan"; jobId: string; changes: PatchProposal["changes"]; basis: Record<string, string> }
  | { type: "confirm_plan"; jobId: string }
  | { type: "commit_chapter"; input: ChapterCommitInput }
  | { type: "commit_report"; jobId: string; report: string; basis: Record<string, string> }
  | { type: "export"; jobId: string };
export type NovelPolicyContext = { now: string; contents: Readonly<Record<string, string | undefined>> };
export type NovelFileChange = { operation: "create" | "replace"; path: string; content: string; baseSha256?: string };
export type NovelDecision = { state: NovelState; changes: NovelFileChange[]; duplicate: boolean; proposal?: PatchProposal; path?: string; adaptation?: ReferenceAdaptation; content?: string; chapterCount?: number };

export function novelCommandPaths(state: NovelState, command: NovelCommand): string[] {
  const authority = ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml", volumePlanPath(state.currentVolume), volumeTensionPath(state.currentVolume)];
  let paths: string[] = [];
  switch (command.type) {
    case "create": paths = ["workspace/ideas.md"]; break;
    case "observe_external": case "author_edit": paths = [command.path]; break;
    case "initialize_bindings": paths = ["workspace/skill-bindings.yaml"]; break;
    case "prepare_proposal": case "apply_proposal": case "approve_proposal": case "reject_proposal": paths = [...authority, ...command.proposal.changes.map((change) => change.path), proposalPath(command.proposal.id)]; break;
    case "create_adaptation": paths = [adaptationPath(command.adaptation.id), ...Object.keys(adaptationAuthorityHashes(state)), ...Object.keys(command.adaptation.authorityFiles)]; break;
    case "transition_adaptation": case "stale_adaptation": paths = [adaptationPath(command.adaptationId), ...Object.keys(adaptationAuthorityHashes(state))]; break;
    case "claim_job": case "confirm_plan": paths = authority; break;
    case "commit_plan": paths = [...authority, ...command.changes.map((change) => change.path), ...Object.keys(command.basis)]; break;
    case "commit_chapter": paths = [...authority, chapterPath(command.input.chapter), actualTensionPath(state.currentVolume), ...Object.keys(command.input.basis), ...command.input.review.newCharacterProfiles.map((profile) => `book/characters/${profile.id}.md`)]; break;
    case "commit_report": paths = [...Object.keys(command.basis), reviewPath(command.jobId)]; break;
    case "export": paths = [...Object.keys(state.files).filter((path) => /^chapters\/chapter-\d+\.md$/.test(path)), exportPath(state.title)]; break;
  }
  return [...new Set(paths.map(validPath))];
}

export function decideNovelCommand(input: NovelState | undefined, command: NovelCommand, context: NovelPolicyContext): NovelDecision {
  if (!input && command.type !== "create") fail("NOVEL_NOT_FOUND", "没有找到这部作品。");
  const state = command.type === "create" ? newNovelState(command.title.trim() || "未命名作品", command.novelId, context.now, command.approvalMode) : novelStateSchema.parse(structuredClone(input));
  const result: NovelDecision = { state, changes: [], duplicate: false };
  const contents = context.contents;
  const read = (path: string) => { const content = contents[path]; if (content === undefined) return fail("FILE_NOT_FOUND", `${path} 不存在。`); return content; };
  const invalidatePlan = (path: string) => {
    if (["book/blueprint.md", "book/tension-curve.yaml", volumePlanPath(state.currentVolume), volumeTensionPath(state.currentVolume)].includes(path) && state.productionAuthorization) delete state.productionAuthorization.confirmedPlan;
  };
  const write = (path: string, content: string, source: "agent" | "author" = "agent", protect?: boolean) => {
    path = validPath(path);
    const prior = state.files[path];
    if (!prior && contents[path] !== undefined) fail("FILE_EXISTS", `${path} 已存在于磁盘，不能覆盖未登记的作者文件。`);
    if (prior && contents[path] === undefined) fail("FILE_NOT_FOUND", `${path} 不存在。`);
    result.changes.push({ operation: prior ? "replace" : "create", path, content, ...(prior ? { baseSha256: prior.sha256 } : {}) });
    state.files[path] = { sha256: contentHash(content), version: (prior?.version ?? 0) + 1, source: source === "author" || prior?.source === "author" ? "author" : "agent", protected: protect ?? Boolean(prior?.protected), updatedAt: context.now };
    if (prior?.sha256 !== state.files[path]!.sha256) invalidatePlan(path);
  };
  const unprotected = (paths: string[]) => { for (const path of paths) if (protectedFile(state, path)) fail("AUTHOR_APPROVAL_REQUIRED", `${path} 已受作者保护，修改需要作者审批。`, "author_approval"); };
  const owner = (jobId: string, goal?: "write_chapters" | "review_project" | "export") => {
    if (state.activeJobId !== jobId) fail("ACTIVE_JOB_CHANGED", "生产任务已取消或被其他任务替代，不能提交。");
    const grant = state.productionAuthorization;
    if (!grant || grant.jobId !== jobId) fail("PRODUCTION_AUTHORIZATION_REQUIRED", "旧任务缺少生产授权，请取消后重新启动。", "replan");
    if (grant.revoked) fail("PRODUCTION_AUTHORIZATION_REVOKED", "任务授权已经撤销，请显式重试以创建新的生产任务。", "replan");
    if (goal && grant.goal !== goal) fail("JOB_GOAL_MISMATCH", "当前任务没有执行这项提交的权限。");
    return grant;
  };
  const checkBasis = (basis: Record<string, string>, required: string[]) => {
    for (const path of new Set([...required, ...Object.keys(basis)])) {
      if (!basis[path] || contents[path] === undefined || contentHash(read(path)) !== basis[path] || state.files[path]?.sha256 !== basis[path]) fail("FILE_STALE", `${path} 已变化或缺少创作依据，请重新读取后生成。`);
    }
  };
  const openingReady = () => {
    if (state.phase !== "writing") fail("BLUEPRINT_INCOMPLETE", "作品尚未进入写作阶段。");
    for (const path of ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"]) if (!state.files[path] || !read(path).trim()) fail("BLUEPRINT_INCOMPLETE", `${path} 尚未准备完整。`);
    validateAsset("book/ledger.yaml", read("book/ledger.yaml"));
    validateAsset("book/tension-curve.yaml", read("book/tension-curve.yaml"));
  };
  const currentPlan = () => {
    const plan = read(volumePlanPath(state.currentVolume));
    const curve = contract("TENSION_CURVE_INVALID", "分卷曲线无效", () => volumeTensionCurveSchema.parse(parse(read(volumeTensionPath(state.currentVolume)))));
    if (curve.volume !== state.currentVolume || curve.basis.volumePlanSha256 !== contentHash(plan) || curve.basis.blueprintSha256 !== state.files["book/blueprint.md"]?.sha256 || curve.basis.bookCurveSha256 !== state.files["book/tension-curve.yaml"]?.sha256) fail("PRODUCTION_PLAN_STALE", "卷计划或曲线依据已变化，请重新规划并确认。", "replan");
    return { plan, curve };
  };
  const checkAdaptationAuthority = (adaptation: ReferenceAdaptation) => {
    if (adaptation.scope.fromChapter < state.nextChapter || adaptation.scope.toChapter > adaptation.scope.fromChapter + 19) fail("ADAPTATION_SCOPE_INVALID", `仿写范围必须从第 ${state.nextChapter} 章或之后开始，单份提案最多覆盖 20 章。`);
    if (!["book/blueprint.md", "book/ledger.yaml"].every((path) => state.files[path] && contents[path]?.trim())) fail("ADAPTATION_TARGET_NOT_READY", "目标作品需要先完成作品蓝图和连续性账本。", "author_approval");
    if (JSON.stringify(canonical(adaptation.authorityFiles)) !== JSON.stringify(canonical(adaptationAuthorityHashes(state)))) fail("ADAPTATION_STALE", "作品规划已经变化，请重新创建仿写提案。", "replan");
    checkBasis(adaptation.authorityFiles, ["book/blueprint.md", "book/ledger.yaml"]);
  };

  switch (command.type) {
    case "create":
      if (input) fail("NOVEL_EXISTS", "作品已经存在。");
      write("workspace/ideas.md", "# 灵感记录\n\n", "author", true);
      break;
    case "observe_external": {
      const path = validPath(command.path); const prior = state.files[path];
      if (!prior) fail("FILE_NOT_FOUND", `${path} 尚未登记。`);
      if (prior.sha256 === contentHash(command.content)) { result.duplicate = true; break; }
      state.files[path] = { ...prior, sha256: contentHash(command.content), version: prior.version + 1, source: "author", protected: true, updatedAt: context.now };
      invalidatePlan(path); break;
    }
    case "initialize_bindings": {
      const path = "workspace/skill-bindings.yaml";
      if (state.files[path]) { result.duplicate = true; break; }
      const existing = contents[path];
      if (existing !== undefined) state.files[path] = { sha256: contentHash(existing), version: 1, source: "author", protected: true, updatedAt: context.now };
      else write(path, yaml(skillBindingsSchema.parse(command.bindings)), "author", true);
      result.path = path; break;
    }
    case "author_edit": {
      const path = validPath(command.path);
      if (internalPath(path)) fail("INTERNAL_FILE_READ_ONLY", `${path} 由专用业务动作维护，不能直接编辑。`);
      if (!state.files[path]) fail("FILE_NOT_FOUND", `${path} 不存在。`);
      if (state.files[path]!.sha256 !== command.expectedSha256 || contentHash(read(path)) !== command.expectedSha256) fail("FILE_STALE", "文件已变化，请重新读取后再保存。");
      let content = command.content;
      validateAsset(path, content);
      if (isTargetTensionCurvePath(path)) content = yaml(markAuthorEdits(targetTensionCurveSchema.parse(parse(read(path))), targetTensionCurveSchema.parse(parse(content))));
      write(path, content, "author", true); result.path = path; break;
    }
    case "prepare_proposal": {
      const proposal = patchProposalSchema.parse({ ...command.proposal, novelId: state.novelId, changes: normalizeChanges(state, command.proposal.changes), status: "pending" });
      assertGeneralChanges(state, proposal.changes, contents);
      proposal.approval = patchApproval(state, proposal.changes);
      if (state.files[proposalPath(proposal.id)]) fail("PROPOSAL_EXISTS", "提案已经登记。");
      write(proposalPath(proposal.id), yaml(proposal), "agent", true); result.proposal = proposal; break;
    }
    case "apply_proposal": case "approve_proposal": case "reject_proposal": {
      const submitted = patchProposalSchema.parse(command.proposal);
      if (submitted.novelId !== state.novelId) fail("PROPOSAL_NOVEL_MISMATCH", "提案不属于当前作品。");
      const path = proposalPath(submitted.id);
      const stored = contract("PROPOSAL_NOT_FOUND", "没有找到已登记提案", () => patchProposalSchema.parse(parse(read(path))));
      if (!sameProposalPayload(submitted, stored)) fail("PROPOSAL_CHANGED", "提案内容与已登记版本不同，请重新生成提案。", "author_approval");
      if (stored.status === "applied" && command.type !== "reject_proposal") { result.proposal = stored; result.duplicate = true; break; }
      if (stored.status !== "pending" || submitted.status !== "pending") fail("PROPOSAL_NOT_PENDING", "这个提案已经处理过。");
      if (command.type === "reject_proposal") { result.proposal = { ...stored, status: "rejected" }; write(path, yaml(result.proposal), "author", true); break; }
      assertGeneralChanges(state, stored.changes, contents);
      const approval = patchApproval(state, stored.changes);
      if (approval === "author" && command.type !== "approve_proposal") fail("AUTHOR_APPROVAL_REQUIRED", "这次修改需要作者确认。", "author_approval");
      for (const change of stored.changes) write(change.path, change.content);
      if (state.phase === "discovery" && ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"].every((path) => state.files[path])) state.phase = "writing";
      state.appliedProposalIds = [...state.appliedProposalIds.slice(-199), stored.id];
      result.proposal = { ...stored, status: "applied" };
      write(path, yaml(result.proposal), command.type === "approve_proposal" ? "author" : "agent", true); break;
    }
    case "claim_job": {
      const request = productionJobRequestSchema.parse(command.request);
      if (!command.jobId.trim()) fail("JOB_ID_REQUIRED", "生产任务必须有明确标识。");
      if (command.options?.expectedStateHash && command.options.expectedStateHash !== stateHash(state)) fail("STATE_STALE", "作品已变化，请重新启动任务。");
      const previous = command.options?.previousJob;
      const previousGrant = state.productionAuthorization;
      const replacesPrevious = previous?.id === state.activeJobId && ["failed", "completed", "canceled"].includes(previous?.status ?? "");
      if (state.activeJobId && state.activeJobId !== command.jobId && !replacesPrevious) fail("ACTIVE_JOB", "当前作品已有生产任务。");
      if (state.activeJobId && (!previousGrant || previousGrant.jobId !== state.activeJobId)) fail("PRODUCTION_AUTHORIZATION_REQUIRED", "旧任务缺少生产授权，请取消后重新启动。", "replan");
      if (state.activeJobId === command.jobId) {
        const prior = owner(command.jobId);
        if (prior.goal !== command.request.goal || JSON.stringify(canonical(prior.scope)) !== JSON.stringify(canonical(command.request.scope)) || prior.interactionMode !== command.interactionMode) fail("JOB_AUTHORIZATION_CHANGED", "已启动任务不能更改生产范围。");
        result.duplicate = true; break;
      }
      if (request.goal === "revise_files") fail("PATCH_REQUIRED", "修订请提交作者可确认的文件提案。", "author_approval");
      if (request.goal === "write_chapters") {
        openingReady();
        const { fromChapter, toChapter } = request.scope;
        if (fromChapter !== state.nextChapter || toChapter === undefined || toChapter < fromChapter || toChapter > fromChapter + 4) fail("CHAPTER_SCOPE_INVALID", `章节范围必须从第 ${state.nextChapter} 章开始，单次最多 5 章。`);
      }
      const retriesAutonomous = replacesPrevious && previous?.status === "failed" && previousGrant?.revoked && previousGrant.interactionMode === "autonomous_opening" && previousGrant.goal === "write_chapters" && previousGrant.scope.toChapter === 3;
      if (command.interactionMode === "autonomous_opening" && ((!retriesAutonomous && state.approvalMode !== "autonomous_opening") || request.goal !== "write_chapters" || state.nextChapter > 3 || request.scope.toChapter !== 3)) fail("AUTONOMOUS_OPENING_COMPLETE", "全自动开书只允许完成已授权的前三章。");
      state.activeJobId = command.jobId;
      state.productionAuthorization = productionAuthorizationSchema.parse({ jobId: command.jobId, goal: request.goal, scope: request.scope, interactionMode: command.interactionMode });
      break;
    }
    case "finish_job": {
      if (!["completed", "failed", "canceled"].includes(command.outcome)) fail("JOB_OUTCOME_INVALID", "生产任务只能通过完成、失败或取消动作结束。");
      if (state.activeJobId !== command.jobId) { result.duplicate = true; break; }
      if (state.productionAuthorization?.interactionMode === "autonomous_opening") state.approvalMode = "milestone";
      if (command.outcome === "failed" && state.productionAuthorization) state.productionAuthorization.revoked = true;
      if (command.outcome !== "failed") { delete state.activeJobId; delete state.productionAuthorization; }
      break;
    }
    case "cancel_autonomous_opening":
      if (state.activeJobId) fail("ACTIVE_JOB", "请先取消当前生产任务。");
      if (state.approvalMode === "milestone") result.duplicate = true;
      else state.approvalMode = "milestone";
      break;
    case "commit_plan": {
      const grant = owner(command.jobId, "write_chapters"); openingReady();
      const planPath = volumePlanPath(state.currentVolume); const curvePath = volumeTensionPath(state.currentVolume);
      checkBasis(command.basis, ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"]);
      for (const change of command.changes) if (change.path === curvePath) {
        const curve = contract("TENSION_CURVE_INVALID", "分卷曲线无效", () => volumeTensionCurveSchema.parse(parse(change.content)));
        if (curve.basis.blueprintSha256 !== state.files["book/blueprint.md"]?.sha256 || curve.basis.bookCurveSha256 !== state.files["book/tension-curve.yaml"]?.sha256) fail("FILE_STALE", "卷规划生成依据已经变化，请重新生成。");
      }
      const changes = normalizeChanges(state, command.changes);
      if (!changes.length || changes.some((change) => ![planPath, curvePath].includes(change.path))) fail("PRODUCTION_PLAN_PATH", "卷规划只能提交当前卷计划与目标曲线。");
      validateChanges(state, changes, contents);
      for (const change of changes) {
        if (change.path === planPath && state.files[planPath] && !change.content.startsWith(read(planPath))) fail("AUTHOR_CONTENT_CHANGED", "补充卷规划必须完整保留已有章节卡正文。", "author_approval");
        if (change.path === curvePath && state.files[curvePath]) {
          const before = volumeTensionCurveSchema.parse(parse(read(curvePath))); const after = volumeTensionCurveSchema.parse(parse(change.content));
          if (before.title !== after.title || before.points.some((point) => JSON.stringify(canonical(point)) !== JSON.stringify(canonical(after.points.find((item) => item.id === point.id))))) fail("AUTHOR_CONTENT_CHANGED", "补充张力曲线不能修改或删除已有节点。", "author_approval");
        }
        write(change.path, change.content);
      }
      const plan = changes.find((change) => change.path === planPath)?.content ?? read(planPath);
      const curve = volumeTensionCurveSchema.parse(parse(changes.find((change) => change.path === curvePath)?.content ?? read(curvePath)));
      if (!planCovers(plan, grant.scope.fromChapter!, grant.scope.toChapter!) || curve.chapterRange.from > grant.scope.fromChapter! || curve.chapterRange.to < grant.scope.toChapter!) fail("PRODUCTION_PLAN_INCOMPLETE", "卷规划没有完整覆盖本次任务章节。");
      delete grant.confirmedPlan; break;
    }
    case "confirm_plan": {
      const grant = owner(command.jobId, "write_chapters"); openingReady();
      const { plan, curve } = currentPlan();
      if (!planCovers(plan, grant.scope.fromChapter!, grant.scope.toChapter!) || curve.chapterRange.from > grant.scope.fromChapter! || curve.chapterRange.to < grant.scope.toChapter!) fail("PRODUCTION_PLAN_INCOMPLETE", "卷规划没有完整覆盖本次任务章节。");
      grant.confirmedPlan = { volume: state.currentVolume, planSha256: state.files[volumePlanPath(state.currentVolume)]!.sha256, curveSha256: state.files[volumeTensionPath(state.currentVolume)]!.sha256 };
      break;
    }
    case "commit_chapter": {
      const { jobId, chapter, text, basis } = command.input; const review = criticResultSchema.parse(command.input.review);
      const grant = owner(jobId, "write_chapters"); openingReady();
      if (chapter !== state.nextChapter || chapter < grant.scope.fromChapter! || chapter > grant.scope.toChapter!) fail("CHAPTER_SEQUENCE", `当前应提交已授权范围内的第 ${state.nextChapter} 章。`);
      if (!text.trim() || review.verdict !== "accepted") fail("CHAPTER_NOT_ACCEPTED", "只有正文非空且独立验收通过的章节可以提交。", "replan");
      const planPath = volumePlanPath(state.currentVolume); const curvePath = volumeTensionPath(state.currentVolume);
      checkBasis(basis, ["book/blueprint.md", "book/ledger.yaml", planPath, curvePath]);
      const confirmed = grant.confirmedPlan;
      if (grant.interactionMode !== "autonomous_opening" && (!confirmed || confirmed.volume !== state.currentVolume || confirmed.planSha256 !== state.files[planPath]?.sha256 || confirmed.curveSha256 !== state.files[curvePath]?.sha256)) fail("PLAN_CONFIRMATION_REQUIRED", "当前卷计划与曲线尚未确认，或确认后已经变化。", "author_approval");
      const { plan, curve } = currentPlan();
      if (!planCovers(plan, chapter, chapter) || !curve.points.some((point) => point.chapter === chapter)) fail("PRODUCTION_PLAN_INCOMPLETE", "当前章节没有完整章节卡和曲线节点。");
      if (chapter > 1 && !state.files[chapterPath(chapter - 1)]) fail("CHAPTER_SEQUENCE", "上一章稳定正文缺失，不能跳章提交。");
      const path = chapterPath(chapter); const actualPath = actualTensionPath(state.currentVolume);
      unprotected([path, "book/ledger.yaml", actualPath]);
      if (state.files[path]) fail("FILE_EXISTS", "稳定章节已经存在，章节生产不能覆盖正文。");
      const ledger = mergeLedger(ledgerSchema.parse(parse(read("book/ledger.yaml"))), chapter, review.continuityDelta);
      write(path, text); write("book/ledger.yaml", yaml(ledger));
      for (const profile of review.newCharacterProfiles) { const path = `book/characters/${profile.id}.md`; if (!state.files[path]) write(path, profile.content); }
      const previous = state.files[actualPath] ? actualTensionCurveSchema.parse(parse(read(actualPath))) : undefined;
      const normalized = (value: string) => value.toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
      const evidence = review.actualTension.evidence.filter((quote) => normalized(text).includes(normalized(quote)));
      const observation = evidence.length ? { ...review.actualTension, evidence } : { ...review.actualTension, evidence: ["正文证据未能精确定位；该观察仅供走势参考。"], confidence: Math.min(review.actualTension.confidence, .35) };
      const points = [...(previous?.points.filter((point) => point.chapter !== chapter) ?? []), { id: `chapter-${String(chapter).padStart(3, "0")}`, chapter, ...observation }].sort((a, b) => a.chapter - b.chapter);
      write(actualPath, yaml(actualTensionCurveSchema.parse({ schemaVersion: 1, kind: "actual", volume: state.currentVolume, basis: { targetCurveSha256: state.files[curvePath]!.sha256, volumePlanSha256: state.files[planPath]!.sha256, chapterHashes: { ...(previous?.basis.chapterHashes ?? {}), [String(chapter)]: contentHash(text) }, generatedAt: context.now }, points, diagnostics: diagnoseTension(points, curve.points) })));
      state.nextChapter = chapter + 1; result.path = path; break;
    }
    case "commit_report": {
      owner(command.jobId, "review_project");
      if (!command.report.trim() || !Object.keys(command.basis).length) fail("REPORT_INVALID", "审查报告或依据不能为空。");
      checkBasis(command.basis, []); const path = reviewPath(command.jobId); unprotected([path]); write(path, command.report); result.path = path; break;
    }
    case "export": {
      owner(command.jobId, "export");
      const chapters = Array.from({ length: state.nextChapter - 1 }, (_, index) => chapterPath(index + 1));
      if (!chapters.length) fail("NO_CHAPTERS", "还没有可导出的稳定章节。");
      const content = chapters.map(read).join("\n\n"); const path = exportPath(state.title); unprotected([path]);
      write(path, content); result.path = path; result.content = content; result.chapterCount = chapters.length; break;
    }
    case "create_adaptation": {
      const adaptation = referenceAdaptationSchema.parse(command.adaptation);
      if (adaptation.novelId !== state.novelId || adaptation.status !== "proposed" || adaptation.approvedAt || adaptation.rejectedAt || adaptation.staleReasons.length) fail("ADAPTATION_INVALID", "新仿写提案必须属于当前作品且处于未批准状态。");
      checkAdaptationAuthority(adaptation);
      const path = adaptationPath(adaptation.id); if (state.files[path]) fail("FILE_EXISTS", "仿写提案已经存在，状态变更须使用专用动作。");
      write(path, yaml(adaptation), "agent", true); result.adaptation = adaptation; result.path = path; break;
    }
    case "transition_adaptation": case "stale_adaptation": {
      if (command.type === "transition_adaptation" && !["approve", "reject"].includes(command.action)) fail("ADAPTATION_ACTION_INVALID", "仿写提案只能通过批准或拒绝动作处理。");
      const path = adaptationPath(command.adaptationId); const previous = referenceAdaptationSchema.parse(parse(read(path)));
      if (previous.novelId !== state.novelId || previous.id !== command.adaptationId) fail("ADAPTATION_INVALID", "仿写提案与当前作品不一致。");
      if (command.type === "transition_adaptation" && command.action === "approve") checkAdaptationAuthority(previous);
      if (command.type === "stale_adaptation" && ["rejected", "stale"].includes(previous.status)) { result.duplicate = true; result.adaptation = previous; result.path = path; break; }
      const adaptation = command.type === "transition_adaptation"
        ? contract("ADAPTATION_NOT_PROPOSED", "这个仿写提案已经处理过", () => transitionAdaptation(previous, command.action, context.now))
        : referenceAdaptationSchema.parse({ ...previous, status: "stale", staleReasons: [...new Set([...previous.staleReasons, ...command.reasons])], updatedAt: context.now });
      write(path, yaml(adaptation), command.type === "transition_adaptation" ? "author" : "agent", true); result.adaptation = adaptation; result.path = path; break;
    }
    default: fail("UNKNOWN_NOVEL_COMMAND", "不支持这个作品修改动作。");
  }
  if (!result.duplicate) state.updatedAt = context.now;
  result.state = novelStateSchema.parse(state);
  return result;
}

function sameProposalPayload(a: PatchProposal, b: PatchProposal) {
  const { status: _a, ...left } = a; const { status: _b, ...right } = b;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function validateAsset(path: string, content: string) {
  path = path.toLowerCase();
  if (path === "book/ledger.yaml") contract("LEDGER_INVALID", "账本内容不符合结构化合同", () => ledgerSchema.parse(parse(content)));
  if (path === "workspace/skill-bindings.yaml") contract("SKILL_BINDINGS_INVALID", "Skill 绑定不符合结构化合同", () => skillBindingsSchema.parse(parse(content)));
  if (path.startsWith("book/characters/") && path.endsWith(".md")) contract("CHARACTER_PROFILE_INVALID", "角色档案不符合文件合同", () => characterProfileContentSchema.parse(content));
  if (isTensionCurvePath(path)) contract("TENSION_CURVE_INVALID", "张力曲线不符合结构化合同", () => {
    const curve = tensionCurveAssetSchema.parse(parse(content));
    if (path === "book/tension-curve.yaml" && curve.kind !== "book") throw new Error("资产类型与路径不匹配");
    if (/^volumes\/volume-\d{3}-tension\.yaml$/.test(path) && curve.kind !== "volume") throw new Error("资产类型与路径不匹配");
    if (/tension-actual\.yaml$/.test(path) && curve.kind !== "actual") throw new Error("资产类型与路径不匹配");
    const volume = Number(path.match(/volume-(\d{3})-tension/)?.[1]);
    if (Number.isFinite(volume) && "volume" in curve && curve.volume !== volume) throw new Error("资产卷号与文件路径不匹配");
  });
}

function validateChanges(state: NovelState, changes: PatchProposal["changes"], contents: NovelPolicyContext["contents"]) {
  const seen = new Set<string>();
  for (const change of changes) {
    validPath(change.path);
    if (seen.has(change.path)) fail("DUPLICATE_PATCH_PATH", "同一提交不能重复修改同一文件。"); seen.add(change.path);
    const current = state.files[change.path];
    if (change.operation === "create" && (current || contents[change.path] !== undefined)) fail("FILE_EXISTS", `${change.path} 已存在。`);
    if (change.operation === "replace" && (!current || contents[change.path] === undefined)) fail("FILE_NOT_FOUND", `${change.path} 不存在。`);
    if (change.operation === "replace" && !change.baseSha256) fail("BASE_HASH_REQUIRED", "替换文件必须提供基础哈希。");
    if (current && (change.baseSha256 !== current.sha256 || contentHash(contents[change.path]!) !== current.sha256)) fail("FILE_STALE", `${change.path} 已变化。`);
    validateAsset(change.path, change.content);
    if (current && isTargetTensionCurvePath(change.path)) {
      const before = targetTensionCurveSchema.parse(parse(contents[change.path]!)); const after = targetTensionCurveSchema.parse(parse(change.content));
      if (lockedPointChanges(before, after).length && !change.overrideLockedNodes) fail("LOCKED_TENSION_NODES", "不能修改作者锁定节点；整条替换必须明确请求覆盖并由作者批准。", "author_approval");
    }
  }
}

function assertGeneralChanges(state: NovelState, changes: PatchProposal["changes"], contents: NovelPolicyContext["contents"]) {
  for (const change of changes) {
    if (internalPath(change.path) || change.path.toLowerCase() === "workspace/skill-bindings.yaml") fail("INTERNAL_FILE_READ_ONLY", `${change.path} 由专用业务动作维护。`);
    if (change.path.toLowerCase().startsWith("chapters/")) {
      const number = Number(/^chapters\/chapter-(\d+)\.md$/i.exec(change.path)?.[1]);
      if (change.operation !== "replace" || !Number.isInteger(number) || number < 1 || number >= state.nextChapter) fail("CHAPTER_COMMIT_REQUIRED", "新章节只能通过已授权的串行生产提交；通用提案只能修订已经提交的正文。");
    }
  }
  validateChanges(state, changes, contents);
  if (state.approvalMode === "autonomous_opening" && state.phase === "discovery" && !isAutonomousOpeningBundle(state, changes)) fail("AUTONOMOUS_OPENING_INVALID", "全自动开书必须一次创建蓝图、账本、曲线和角色档案，且不能包含其他创作文件。", "retry");
  if (changes.some((change) => change.path === "book/blueprint.md")) {
    if (!state.files["book/ledger.yaml"] && !changes.some((change) => change.path === "book/ledger.yaml")) fail("LEDGER_REQUIRED", "确认蓝图时必须同时提供连续性账本。", "retry");
    if (!state.files["book/tension-curve.yaml"] && !changes.some((change) => change.path === "book/tension-curve.yaml")) fail("TENSION_CURVE_REQUIRED", "确认蓝图时必须同时提供全书张力曲线。", "retry");
  }
}

function normalizeChanges(state: NovelState, raw: PatchProposal["changes"]): PatchProposal["changes"] {
  const changes = raw.map((change) => ({ ...change, path: validPath(change.path) }));
  const hash = (path: string) => { const change = changes.find((item) => item.path === path); return change ? contentHash(change.content) : state.files[path]?.sha256; };
  const book = changes.find((change) => change.path === "book/tension-curve.yaml");
  if (book) book.content = contract("TENSION_CURVE_INVALID", "全书曲线无效", () => { const curve = bookTensionCurveSchema.parse(parse(book.content)); curve.basis.blueprintSha256 = hash("book/blueprint.md") ?? curve.basis.blueprintSha256; return yaml(curve); });
  return changes.map((change) => {
    if (!isTargetTensionCurvePath(change.path) || change.path === "book/tension-curve.yaml") return change;
    return contract("TENSION_CURVE_INVALID", "分卷曲线无效", () => {
      const curve = volumeTensionCurveSchema.parse(parse(change.content));
      curve.basis.blueprintSha256 = hash("book/blueprint.md") ?? curve.basis.blueprintSha256;
      curve.basis.bookCurveSha256 = hash("book/tension-curve.yaml") ?? curve.basis.bookCurveSha256;
      curve.basis.volumePlanSha256 = hash(volumePlanPath(curve.volume)) ?? curve.basis.volumePlanSha256;
      return { ...change, content: yaml(curve) };
    });
  });
}

function chapterNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }; const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0; let digit = 0;
  for (const character of value) { if (character in digits) digit = digits[character]!; else if (character in units) { total += (digit || 1) * units[character]!; digit = 0; } else return Number.NaN; }
  return total + digit;
}
function planCovers(plan: string, from: number, to: number) {
  const chapters = new Set([...plan.matchAll(/^#{1,6}\s*第\s*([\d零〇一二两三四五六七八九十百千]+)\s*章(?=\s|《|[：:—-]|$).*$/gm)].map((match) => chapterNumber(match[1]!)));
  for (let chapter = from; chapter <= to; chapter++) if (!chapters.has(chapter)) return false;
  return true;
}
