import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import {
  ledgerSchema, mergeLedger, newNovelState, normalizeNovelPath, novelStateSchema, patchApproval, patchProposalSchema,
  type NovelLedger, type NovelState, type PatchProposal,
} from "../domain";
import { AppError } from "../application/errors";
import type { FileContent, NovelFileView, NovelSummary } from "../shared/contracts";

const textLimit = 1_000_000;
export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const novelStateHash = (state: NovelState) => sha256(JSON.stringify(canonical(state)));

async function atomicWrite(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

export class NovelRepository {
  readonly root: string;
  constructor(root = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), "novels")) { this.root = root; }

  private directory(novelId: string) {
    const id = zUuid(novelId);
    const target = path.resolve(this.root, id);
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false);
    return target;
  }
  private statePath(novelId: string) { return path.join(this.directory(novelId), "novel-state.yaml"); }
  private filePath(novelId: string, relativePath: string) {
    const clean = normalizePath(relativePath);
    const root = this.directory(novelId);
    const target = path.resolve(root, clean);
    if (!target.startsWith(`${root}${path.sep}`)) throw new AppError("INVALID_NOVEL_PATH", "作品文件路径无效。", 400, false);
    return target;
  }

  async create(title: string): Promise<NovelState> {
    const novelId = randomUUID();
    const now = new Date().toISOString();
    const state = newNovelState(title.trim() || "未命名作品", novelId, now);
    const ideas = "# 灵感记录\n\n";
    state.files["workspace/ideas.md"] = { sha256: sha256(ideas), version: 1, source: "author", protected: true, updatedAt: now };
    await mkdir(this.directory(novelId), { recursive: false });
    await Promise.all([
      atomicWrite(this.filePath(novelId, "workspace/ideas.md"), ideas),
      mkdir(path.join(this.directory(novelId), "workspace", "references"), { recursive: true }),
    ]);
    await this.writeState(state);
    return state;
  }

  async get(novelId: string): Promise<NovelState> {
    try { return novelStateSchema.parse(parse(await readFile(this.statePath(novelId), "utf8"))); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false);
    }
  }

  async list(): Promise<NovelSummary[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const novels = await Promise.all(entries.filter((item) => item.isDirectory()).map(async (item) => this.get(item.name).catch(() => undefined)));
    return novels.filter((item): item is NovelState => Boolean(item)).map(({ novelId, title, phase, nextChapter, updatedAt }) => ({ novelId, title, phase, nextChapter, updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listFiles(novelId: string): Promise<NovelFileView[]> {
    const state = await this.get(novelId);
    return Promise.all(Object.entries(state.files).map(async ([filePath, record]) => ({ path: filePath, ...record, size: (await stat(this.filePath(novelId, filePath)).catch(() => ({ size: 0 }))).size })));
  }

  async readProjectFile(novelId: string, relativePath: string, offset = 0, maxChars = 40_000): Promise<FileContent> {
    const state = await this.get(novelId);
    const clean = normalizePath(relativePath);
    let record = state.files[clean];
    if (!record) throw new AppError("FILE_NOT_FOUND", "没有找到这个作品文件。", 404, true, undefined, "reread");
    const target = this.filePath(novelId, clean);
    const metadata = await stat(target);
    if (metadata.size > textLimit) throw new AppError("FILE_TOO_LARGE", "文件过大，请缩小读取范围。", 413, true, undefined, "reread");
    const full = await readFile(target, "utf8");
    const actualSha256 = sha256(full);
    if (actualSha256 !== record.sha256) {
      const now = new Date().toISOString();
      record = { sha256: actualSha256, version: record.version + 1, source: "author", protected: true, updatedAt: now };
      state.files[clean] = record;
      state.updatedAt = now;
      await this.writeState(state);
    }
    return { path: clean, ...record, size: metadata.size, content: full.slice(offset, offset + maxChars) };
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
    const changes = input.changes.map((change) => ({ ...change, path: normalizePath(change.path) }));
    await Promise.all(changes.filter((change) => change.operation === "replace").map((change) => this.readProjectFile(novelId, change.path, 0, 1)));
    const state = await this.get(novelId);
    this.validateChanges(state, changes);
    return patchProposalSchema.parse({ id: randomUUID(), novelId, intent: input.intent, summary: input.summary, changes, approval: patchApproval(state, changes), status: "pending", createdAt: new Date().toISOString() });
  }

  async applyProposal(raw: PatchProposal, authorApproved = false, updateState?: (state: NovelState) => void): Promise<{ proposal: PatchProposal; state: NovelState; duplicate: boolean }> {
    const proposal = patchProposalSchema.parse(raw);
    await Promise.all(proposal.changes.filter((change) => change.operation === "replace").map((change) => this.readProjectFile(proposal.novelId, change.path, 0, 1)));
    let state = await this.get(proposal.novelId);
    if (state.appliedProposalIds.includes(proposal.id)) return { proposal: { ...proposal, status: "applied" }, state, duplicate: true };
    this.validateChanges(state, proposal.changes);
    const approval = patchApproval(state, proposal.changes);
    if (approval === "author" && !authorApproved) throw new AppError("AUTHOR_APPROVAL_REQUIRED", "这次修改需要作者确认。", 409, true, undefined, "author_approval");
    const backups = new Map<string, string | undefined>();
    try {
      for (const change of proposal.changes) {
        const target = this.filePath(proposal.novelId, change.path);
        backups.set(change.path, await readFile(target, "utf8").catch(() => undefined));
        await atomicWrite(target, change.content);
      }
    } catch (error) {
      for (const [filePath, content] of backups) {
        const target = this.filePath(proposal.novelId, filePath);
        if (content === undefined) await unlink(target).catch(() => undefined);
        else await atomicWrite(target, content).catch(() => undefined);
      }
      throw error;
    }
    const now = new Date().toISOString();
    for (const change of proposal.changes) {
      const prior = state.files[change.path];
      state.files[change.path] = { sha256: sha256(change.content), version: (prior?.version ?? 0) + 1, source: prior?.source === "author" ? "author" : "agent", protected: Boolean(prior?.protected), updatedAt: now };
    }
    if (state.files["book/blueprint.md"] && state.files["book/ledger.yaml"] && state.phase === "discovery") state.phase = "writing";
    state.appliedProposalIds = [...state.appliedProposalIds.slice(-199), proposal.id];
    updateState?.(state);
    state.updatedAt = now;
    await this.writeState(state);
    return { proposal: { ...proposal, approval, status: "applied" }, state, duplicate: false };
  }

  async saveAuthorFile(novelId: string, relativePath: string, content: string, expectedSha256: string) {
    await this.readProjectFile(novelId, relativePath, 0, 1);
    const state = await this.get(novelId);
    const clean = normalizePath(relativePath);
    const current = state.files[clean];
    if (!current) throw new AppError("FILE_NOT_FOUND", "没有找到这个作品文件。", 404, false);
    if (current.sha256 !== expectedSha256) throw new AppError("FILE_STALE", "文件已变化，请重新读取后再保存。", 409, true, undefined, "reread");
    await atomicWrite(this.filePath(novelId, clean), content);
    const now = new Date().toISOString();
    state.files[clean] = { sha256: sha256(content), version: current.version + 1, source: "author", protected: true, updatedAt: now };
    state.updatedAt = now;
    await this.writeState(state);
    return this.readProjectFile(novelId, clean);
  }

  async readLedger(novelId: string): Promise<NovelLedger> {
    const state = await this.get(novelId);
    if (!state.files["book/ledger.yaml"]) return ledgerSchema.parse({ version: 1 });
    return ledgerSchema.parse(parse((await this.readProjectFile(novelId, "book/ledger.yaml", 0, textLimit)).content));
  }

  async commitChapter(novelId: string, chapter: number, text: string, delta: Parameters<typeof mergeLedger>[2]) {
    const state = await this.get(novelId);
    if (state.nextChapter !== chapter) throw new AppError("CHAPTER_SEQUENCE", `当前应提交第 ${state.nextChapter} 章。`, 409, false);
    const ledger = mergeLedger(await this.readLedger(novelId), chapter, delta);
    const chapterPath = `chapters/chapter-${String(chapter).padStart(3, "0")}.md`;
    const changes: PatchProposal["changes"] = [
      { operation: state.files[chapterPath] ? "replace" : "create", path: chapterPath, ...(state.files[chapterPath] ? { baseSha256: state.files[chapterPath]!.sha256 } : {}), content: text },
      { operation: state.files["book/ledger.yaml"] ? "replace" : "create", path: "book/ledger.yaml", ...(state.files["book/ledger.yaml"] ? { baseSha256: state.files["book/ledger.yaml"]!.sha256 } : {}), content: stringify(ledger, { lineWidth: 0 }) },
    ];
    const proposal = await this.prepareProposal(novelId, { intent: `提交第 ${chapter} 章`, summary: `稳定提交第 ${chapter} 章与连续性`, changes });
    const result = await this.applyProposal({ ...proposal, approval: "auto" }, true, (next) => { next.nextChapter = chapter + 1; });
    return { state: result.state, path: chapterPath, sha256: result.state.files[chapterPath]!.sha256 };
  }

  async setActiveJob(novelId: string, jobId?: string) {
    const state = await this.get(novelId);
    if (jobId && state.activeJobId && state.activeJobId !== jobId) throw new AppError("ACTIVE_JOB", "当前作品已有生产任务。", 409, true);
    state.activeJobId = jobId;
    state.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  async clearActiveJob(novelId: string, jobId: string) {
    const state = await this.get(novelId);
    if (state.activeJobId !== jobId) return state;
    state.activeJobId = undefined;
    state.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  async exportNovel(novelId: string) {
    const state = await this.get(novelId);
    const chapters = Object.keys(state.files).filter((item) => /^chapters\/chapter-\d+\.md$/.test(item)).sort();
    if (!chapters.length) throw new AppError("NO_CHAPTERS", "还没有可导出的稳定章节。", 409, true);
    const content = (await Promise.all(chapters.map(async (item) => (await this.readProjectFile(novelId, item, 0, textLimit)).content))).join("\n\n");
    const exportPath = `exports/${safeFileName(state.title)}.txt`;
    const proposal = await this.prepareProposal(novelId, {
      intent: "导出稳定章节",
      summary: `导出 ${chapters.length} 章`,
      changes: [{ operation: state.files[exportPath] ? "replace" : "create", path: exportPath, ...(state.files[exportPath] ? { baseSha256: state.files[exportPath]!.sha256 } : {}), content }],
    });
    await this.applyProposal({ ...proposal, approval: "auto" }, true);
    return { path: exportPath, chapterCount: chapters.length, sha256: sha256(content), content };
  }

  private validateChanges(state: NovelState, changes: PatchProposal["changes"]) {
    const seen = new Set<string>();
    for (const change of changes) {
      if (seen.has(change.path)) throw new AppError("DUPLICATE_PATCH_PATH", "同一提案不能重复修改同一文件。", 400, false);
      seen.add(change.path);
      const current = state.files[change.path];
      if (change.operation === "create" && current) throw new AppError("FILE_EXISTS", `${change.path} 已存在。`, 409, true, undefined, "reread");
      if (change.operation === "replace" && !current) throw new AppError("FILE_NOT_FOUND", `${change.path} 不存在。`, 409, true, undefined, "reread");
      if (change.operation === "replace" && !change.baseSha256) throw new AppError("BASE_HASH_REQUIRED", "替换文件必须提供基础哈希。", 400, false);
      if (current && change.baseSha256 !== current.sha256) throw new AppError("FILE_STALE", `${change.path} 已变化。`, 409, true, undefined, "reread");
      if (change.path === "book/ledger.yaml") {
        try { ledgerSchema.parse(parse(change.content)); }
        catch (error) {
          const detail = error instanceof ZodError ? error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "根节点"}: ${issue.message}`).join("；") : "YAML 无法解析";
          throw new AppError("LEDGER_INVALID", `账本内容不符合结构化合同：${detail}`, 400, true, undefined, "retry");
        }
      }
    }
    const opensBook = changes.some((change) => change.path === "book/blueprint.md");
    const suppliesLedger = Boolean(state.files["book/ledger.yaml"]) || changes.some((change) => change.path === "book/ledger.yaml");
    if (opensBook && !suppliesLedger) throw new AppError("LEDGER_REQUIRED", "确认作品蓝图时必须在同一提案中提交连续性账本。", 400, true, undefined, "retry");
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
function safeFileName(value: string) { return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 80) || "novel"; }
