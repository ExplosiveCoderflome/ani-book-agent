import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  criticResultSchema, ledgerSchema, normalizeNovelPath, novelStateSchema, patchProposalSchema, referenceAdaptationSchema,
  type ApprovalMode, type NovelLedger, type NovelState, type PatchProposal, type ReferenceAdaptation,
  type ProductionInteractionMode, type ProductionJobRequest, type SkillBindings, type FileContent, type NovelFileView, type NovelSummary,
} from "../domain";
import {
  contentHash, stateHash, adaptationAuthorityHashes, decideNovelCommand, novelCommandPaths, NovelPolicyError,
  type ChapterCommitInput, type ClaimOptions, type NovelCommand, type NovelDecision, type NovelFileChange,
} from "../domain/novel-commands";
import { AppError } from "../application/errors";
import { withNovelLock } from "./novel-lock";

const textLimit = 1_000_000;
export const sha256 = contentHash;
export const novelStateHash = stateHash;

async function atomicWrite(filePath: string, content: string, createOnly = false) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    if (createOnly) await link(temporary, filePath);
    else await rename(temporary, filePath);
  } finally { await unlink(temporary).catch(() => undefined); }
}

const pendingCommitSchema = z.object({
  phase: z.enum(["prepared", "rolling_back"]).default("prepared"),
  beforeState: z.string().nullable(), afterStateSha256: z.string().length(64),
  files: z.array(z.object({ path: z.string(), before: z.string().nullable(), afterSha256: z.string().length(64) })),
});
type PendingCommit = z.infer<typeof pendingCommitSchema>;
async function readOptional(filePath: string) {
  try { return await readFile(filePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export class NovelRepository {
  readonly root: string;
  constructor(root = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), "novels")) { this.root = root; }
  stateHash(state: NovelState) { return novelStateHash(state); }

  private directory(novelId: string) {
    const id = zUuid(novelId);
    const target = path.resolve(this.root, id);
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false);
    return target;
  }
  private statePath(novelId: string) { return path.join(this.directory(novelId), "novel-state.yaml"); }
  private filePath(novelId: string, relativePath: string) {
    const root = this.directory(novelId);
    const target = path.resolve(root, normalizePath(relativePath));
    if (!target.startsWith(`${root}${path.sep}`)) throw new AppError("INVALID_NOVEL_PATH", "作品文件路径无效。", 400, false);
    return target;
  }

  // Every public mutation enters the same lock and applies one pure domain decision.
  // Read reconciliation uses this same finalizer because external author edits change authority.
  private async execute(novelId: string, command: NovelCommand): Promise<NovelDecision> {
    return withNovelLock(this.directory(novelId), async () => {
      try {
        let state = command.type === "create" ? undefined : await this.get(novelId);
        const contents: Record<string, string | undefined> = {};
        const paths = command.type === "create" ? ["workspace/ideas.md"] : novelCommandPaths(state!, command);
        for (const relativePath of paths) {
          const content = await readOptional(this.filePath(novelId, relativePath));
          contents[relativePath] = content ?? undefined;
          if (state?.files[relativePath] && content !== null && state.files[relativePath]!.sha256 !== sha256(content)) {
            const observed = decideNovelCommand(state, { type: "observe_external", path: relativePath, content }, { now: new Date().toISOString(), contents });
            await this.finalize(observed);
            state = observed.state;
          }
        }
        const decision = decideNovelCommand(state, command, { now: new Date().toISOString(), contents });
        await this.finalize(decision);
        return decision;
      } catch (error) {
        if (error instanceof NovelPolicyError) throw new AppError(error.code, error.message, error.code.endsWith("NOT_FOUND") ? 404 : 409, error.recoverable, undefined, error.nextAction);
        throw error;
      }
    });
  }
  private async finalize(decision: NovelDecision) {
    if (!decision.duplicate) await this.commitFiles(decision.state, decision.changes);
  }

  async create(title: string, approvalMode: ApprovalMode = "milestone"): Promise<NovelState> {
    const novelId = randomUUID();
    return (await this.execute(novelId, { type: "create", novelId, title, approvalMode })).state;
  }

  async get(novelId: string): Promise<NovelState> {
    return withNovelLock(this.directory(novelId), async () => {
      await this.recoverPendingCommit(novelId);
      try { return novelStateSchema.parse(parse(await readFile(this.statePath(novelId), "utf8"))); }
      catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false);
      }
    });
  }
  async list(): Promise<NovelSummary[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const novels = await Promise.all(entries.filter((item) => item.isDirectory()).map(async (item) => this.get(item.name).catch(() => undefined)));
    return novels.filter((item): item is NovelState => Boolean(item)).map(({ novelId, title, phase, nextChapter, updatedAt }) => ({ novelId, title, phase, nextChapter, updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listFiles(novelId: string): Promise<NovelFileView[]> {
    return withNovelLock(this.directory(novelId), async () => {
      const state = await this.get(novelId);
      return Promise.all(Object.entries(state.files).map(async ([filePath, record]) => ({ path: filePath, ...record, size: (await stat(this.filePath(novelId, filePath)).catch(() => ({ size: 0 }))).size })));
    });
  }
  async readProjectFile(novelId: string, relativePath: string, offset = 0, maxChars = 40_000): Promise<FileContent> {
    return withNovelLock(this.directory(novelId), async () => {
      let state = await this.get(novelId);
      const clean = normalizePath(relativePath);
      if (!state.files[clean]) throw new AppError("FILE_NOT_FOUND", "没有找到这个作品文件。", 404, true, undefined, "reread");
      const target = this.filePath(novelId, clean);
      const metadata = await stat(target);
      if (metadata.size > textLimit) throw new AppError("FILE_TOO_LARGE", "文件过大，请缩小读取范围。", 413, true, undefined, "reread");
      const full = await readFile(target, "utf8");
      if (sha256(full) !== state.files[clean]!.sha256) {
        const decision = decideNovelCommand(state, { type: "observe_external", path: clean, content: full }, { now: new Date().toISOString(), contents: { [clean]: full } });
        await this.finalize(decision);
        state = decision.state;
      }
      return { path: clean, ...state.files[clean]!, size: metadata.size, content: full.slice(offset, offset + maxChars) };
    });
  }
  async search(novelId: string, query: string, limit = 8) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const files = await this.listFiles(novelId);
    const matches: Array<{ path: string; excerpt: string }> = [];
    for (const file of files) {
      if (matches.length >= limit || !/\.(md|ya?ml|txt|json)$/i.test(file.path)) continue;
      const content = (await this.readProjectFile(novelId, file.path, 0, textLimit)).content;
      const index = content.toLocaleLowerCase().indexOf(needle);
      if (index >= 0) matches.push({ path: file.path, excerpt: content.slice(Math.max(0, index - 180), index + query.length + 320) });
    }
    return matches;
  }
  async prepareProposal(novelId: string, input: { intent: string; summary: string; changes: PatchProposal["changes"] }): Promise<PatchProposal> {
    const proposal = patchProposalSchema.parse({ ...input, id: randomUUID(), novelId, approval: "auto", status: "pending", createdAt: new Date().toISOString() });
    return (await this.execute(novelId, { type: "prepare_proposal", proposal })).proposal!;
  }
  async applyProposal(raw: PatchProposal): Promise<{ proposal: PatchProposal; state: NovelState; duplicate: boolean }> {
    const proposal = patchProposalSchema.parse(raw);
    const result = await this.execute(proposal.novelId, { type: "apply_proposal", proposal });
    return { proposal: result.proposal!, state: result.state, duplicate: result.duplicate };
  }
  async approveProposal(raw: PatchProposal): Promise<{ proposal: PatchProposal; state: NovelState; duplicate: boolean }> {
    const proposal = patchProposalSchema.parse(raw);
    const result = await this.execute(proposal.novelId, { type: "approve_proposal", proposal });
    return { proposal: result.proposal!, state: result.state, duplicate: result.duplicate };
  }
  async rejectProposal(raw: PatchProposal): Promise<PatchProposal> {
    const proposal = patchProposalSchema.parse(raw);
    return (await this.execute(proposal.novelId, { type: "reject_proposal", proposal })).proposal!;
  }
  async saveAuthorFile(novelId: string, relativePath: string, content: string, expectedSha256: string): Promise<FileContent> {
    return withNovelLock(this.directory(novelId), async () => {
      const result = await this.execute(novelId, { type: "author_edit", path: relativePath, content, expectedSha256 });
      return this.readProjectFile(novelId, result.path!);
    });
  }
  async initializeSkillBindings(novelId: string, bindings: SkillBindings): Promise<FileContent> {
    return withNovelLock(this.directory(novelId), async () => {
      await this.execute(novelId, { type: "initialize_bindings", bindings });
      return this.readProjectFile(novelId, "workspace/skill-bindings.yaml", 0, 100_000);
    });
  }
  adaptationAuthorityFiles(state: NovelState) {
    return adaptationAuthorityHashes(state);
  }
  adaptationSetHash(versions: Record<string, string>) { return sha256(JSON.stringify(Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))); }
  async saveAdaptation(raw: ReferenceAdaptation) {
    const adaptation = referenceAdaptationSchema.parse(raw);
    const result = await this.execute(adaptation.novelId, { type: "create_adaptation", adaptation });
    return { adaptation: result.adaptation!, file: result.state.files[result.path!]! };
  }
  async adaptations(novelId: string) {
    return withNovelLock(this.directory(novelId), async () => {
      const state = await this.get(novelId);
      const paths = Object.keys(state.files).filter((filePath) => /^workspace\/references\/adaptations\/[0-9a-f-]+\.yaml$/i.test(filePath));
      const values = [];
      for (const filePath of paths) values.push(await this.readProjectFile(novelId, filePath, 0, 300_000).then((file) => ({ adaptation: referenceAdaptationSchema.parse(parse(file.content)), file })).catch(() => undefined));
      return values.filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((left, right) => right.adaptation.updatedAt.localeCompare(left.adaptation.updatedAt));
    });
  }
  async updateAdaptation(novelId: string, adaptationId: string, action: "approve" | "reject") {
    const result = await this.execute(novelId, { type: "transition_adaptation", adaptationId, action });
    return { adaptation: result.adaptation!, file: result.state.files[result.path!]! };
  }
  async markAdaptationStale(novelId: string, adaptationId: string, reasons: ReferenceAdaptation["staleReasons"]) {
    const result = await this.execute(novelId, { type: "stale_adaptation", adaptationId, reasons });
    return { adaptation: result.adaptation!, file: result.state.files[result.path!]! };
  }
  async activeAdaptations(novelId: string, chapter: number) {
    return (await this.adaptations(novelId)).filter(({ adaptation }) => adaptation.status === "approved" && adaptation.scope.fromChapter <= chapter && adaptation.scope.toChapter >= chapter);
  }
  async readLedger(novelId: string): Promise<NovelLedger> {
    return withNovelLock(this.directory(novelId), async () => {
      const state = await this.get(novelId);
      if (!state.files["book/ledger.yaml"]) return ledgerSchema.parse({ version: 1 });
      return ledgerSchema.parse(parse((await this.readProjectFile(novelId, "book/ledger.yaml", 0, textLimit)).content));
    });
  }
  async claimProductionJob(novelId: string, jobId: string, request: ProductionJobRequest, interactionMode: ProductionInteractionMode, options?: ClaimOptions): Promise<NovelState> {
    return (await this.execute(novelId, { type: "claim_job", jobId, request, interactionMode, options })).state;
  }
  async finishProductionJob(novelId: string, jobId: string, outcome: "completed" | "failed" | "canceled"): Promise<NovelState> {
    return (await this.execute(novelId, { type: "finish_job", jobId, outcome })).state;
  }
  async cancelAutonomousOpening(novelId: string): Promise<NovelState> {
    return (await this.execute(novelId, { type: "cancel_autonomous_opening" })).state;
  }
  async commitProductionPlan(novelId: string, jobId: string, changes: PatchProposal["changes"], basis: Record<string, string>): Promise<NovelState> {
    return (await this.execute(novelId, { type: "commit_plan", jobId, changes, basis })).state;
  }
  async confirmProductionPlan(novelId: string, jobId: string): Promise<NovelState> {
    return (await this.execute(novelId, { type: "confirm_plan", jobId })).state;
  }
  async commitChapter(novelId: string, input: ChapterCommitInput): Promise<{ state: NovelState; path: string; sha256: string }> {
    const result = await this.execute(novelId, { type: "commit_chapter", input: { ...input, review: criticResultSchema.parse(input.review) } });
    return { state: result.state, path: result.path!, sha256: result.state.files[result.path!]!.sha256 };
  }
  async commitReviewReport(novelId: string, jobId: string, report: string, basis: Record<string, string>): Promise<{ path: string }> {
    return { path: (await this.execute(novelId, { type: "commit_report", jobId, report, basis })).path! };
  }
  async exportNovel(novelId: string, jobId: string) {
    const result = await this.execute(novelId, { type: "export", jobId });
    return { path: result.path!, chapterCount: result.chapterCount!, sha256: sha256(result.content!), content: result.content! };
  }

  private pendingCommitPath(novelId: string) { return path.join(this.directory(novelId), ".pending-commit.json"); }

  private async commitFiles(state: NovelState, changes: NovelFileChange[]) {
    const serialized = stringify(novelStateSchema.parse(state), { lineWidth: 0 });
    const journal: PendingCommit = {
      phase: "prepared",
      beforeState: await readOptional(this.statePath(state.novelId)),
      afterStateSha256: sha256(serialized),
      files: [],
    };
    for (const change of changes) {
      const before = await readOptional(this.filePath(state.novelId, change.path));
      if (change.operation === "create" && before !== null) throw new AppError("FILE_EXISTS", `${change.path} 已存在于磁盘，不能覆盖作者文件。`, 409, true, undefined, "reread");
      if (change.operation === "replace" && (before === null || sha256(before) !== change.baseSha256)) throw new AppError("FILE_STALE", `${change.path} 已变化，请重新读取后再保存。`, 409, true, undefined, "reread");
      journal.files.push({ path: normalizePath(change.path), before, afterSha256: sha256(change.content) });
    }
    await atomicWrite(this.pendingCommitPath(state.novelId), JSON.stringify(journal));
    try {
      for (const [index, change] of changes.entries()) {
        const target = this.filePath(state.novelId, change.path);
        const before = journal.files[index]!.before;
        if (await readOptional(target) !== before) throw new AppError("FILE_STALE", `${change.path} 在提交过程中发生了外部修改，已停止写入。`, 409, true, undefined, "reread");
        await atomicWrite(target, change.content, before === null);
      }
      await this.writeState(state);
    } catch (error) {
      try {
        journal.phase = "rolling_back";
        await atomicWrite(this.pendingCommitPath(state.novelId), JSON.stringify(journal));
        await this.rollbackCommit(state.novelId, journal);
      }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "作品提交与回滚未完成，恢复日志已保留。请恢复文件访问后重试。"); }
      throw error;
    }
    // The state rename commits the batch. A leftover journal is cleanup work, never a reason to roll it back.
    await this.removePendingCommit(state.novelId).catch(() => undefined);
  }

  private async recoverPendingCommit(novelId: string) {
    const content = await readOptional(this.pendingCommitPath(novelId));
    if (content === null) return;
    const journal = pendingCommitSchema.parse(JSON.parse(content));
    if (journal.phase === "prepared" && sha256((await readOptional(this.statePath(novelId))) ?? "") === journal.afterStateSha256) {
      await this.removePendingCommit(novelId);
      return;
    }
    await this.rollbackCommit(novelId, journal);
  }

  private async removePendingCommit(novelId: string) { await unlink(this.pendingCommitPath(novelId)); }

  private async rollbackCommit(novelId: string, journal: PendingCommit) {
    const before = journal.beforeState === null ? undefined : novelStateSchema.parse(parse(journal.beforeState));
    const currentState = await readOptional(this.statePath(novelId));
    if ((before && before.novelId !== novelId) || (currentState !== journal.beforeState && sha256(currentState ?? "") !== journal.afterStateSha256)) throw new AppError("NOVEL_RECOVERY_CONFLICT", "未完成提交后作品状态发生了外部修改，已保留文件与恢复日志。", 409, false);
    // Check the entire batch before restoring anything, so recovery never overwrites a later author edit.
    const currentFiles = [];
    for (const file of journal.files) {
      const target = this.filePath(novelId, file.path);
      const content = await readOptional(target);
      if (content !== file.before && (content === null || sha256(content) !== file.afterSha256)) throw new AppError("NOVEL_RECOVERY_CONFLICT", `${file.path} 在未完成提交后发生了外部修改，已保留文件与恢复日志。`, 409, false);
      currentFiles.push({ ...file, target, content });
    }
    for (const file of currentFiles) {
      if (file.content === file.before) continue;
      if (file.before === null) await unlink(file.target);
      else await atomicWrite(file.target, file.before);
    }
    if (currentState !== journal.beforeState) {
      if (journal.beforeState === null) await unlink(this.statePath(novelId));
      else await atomicWrite(this.statePath(novelId), journal.beforeState);
    }
    await this.removePendingCommit(novelId);
  }

  private async writeState(state: NovelState) { await atomicWrite(this.statePath(state.novelId), stringify(novelStateSchema.parse(state), { lineWidth: 0 })); }
}

function zUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false);
  return value;
}
function normalizePath(value: string) {
  try { return normalizeNovelPath(value); }
  catch { throw new AppError("INVALID_NOVEL_PATH", "作品文件路径无效。", 400, false); }
}
