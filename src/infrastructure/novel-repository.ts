import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { DatabaseSync } from "node:sqlite";
import { artifactKey, decideNextAction, novelStateSchema, untitledNovelTitle, type ArtifactState, type NovelState, type ProductionStage } from "../domain";
import { AppError } from "../application/errors";
import { artifactProposalSchema, novelBriefSchema, openingChoicesInputSchema, promptVersion, type ArtifactProposal, type NovelBrief, type NovelSummary } from "../shared/contracts";

const BRIEF_PATH = "book/novel-brief.md";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function novelInputHash(state: NovelState, dependencies: string[] = []): string {
  const selected = dependencies.map((key) => ({ key, sha256: state.artifacts[key]?.sha256 ?? null }));
  return sha256(stableJson({ title: state.title, openingChoices: state.openingChoices, dependencies: selected }));
}

export function renderNovelBrief(brief: NovelBrief): string {
  const risks = brief.risks.map((risk) => `- ${risk}`).join("\n");
  return `# ${brief.workingTitle}\n\n> ${brief.oneSentencePremise}\n\n## 目标读者\n\n${brief.targetReaders}\n\n## 主要阅读回报\n\n${brief.primaryReaderReward}\n\n## 主角\n\n${brief.protagonist}\n\n## 核心冲突\n\n${brief.coreConflict}\n\n## 故事引擎\n\n${brief.storyEngine}\n\n## 开篇钩子\n\n${brief.openingHook}\n\n## 长线承诺\n\n${brief.longTermPromise}\n\n## 风险与提醒\n\n${risks}\n`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, filePath);
}

function normalizeArtifactPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new AppError("INVALID_PATH", "工件路径无效。", 400, false);
  }
  return normalized;
}

export class NovelRepository {
  readonly root: string;

  constructor(root = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), "novels")) {
    this.root = root;
  }

  private novelDirectory(novelId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(novelId)) throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false);
    const directory = path.resolve(this.root, novelId);
    if (path.dirname(directory) !== path.resolve(this.root)) throw new AppError("INVALID_PATH", "作品路径无效。", 400, false);
    return directory;
  }

  private statePath(novelId: string): string { return path.join(this.novelDirectory(novelId), "novel-state.yaml"); }

  private artifactPath(novelId: string, relativePath: string): string {
    const root = this.novelDirectory(novelId);
    const target = path.resolve(root, normalizeArtifactPath(relativePath));
    if (!target.startsWith(`${root}${path.sep}`)) throw new AppError("INVALID_PATH", "工件路径无效。", 400, false);
    return target;
  }

  async create(title: string, approvalMode: "milestone_approval" | "auto" = "milestone_approval"): Promise<NovelState> {
    const now = new Date().toISOString();
    const state: NovelState = { schemaVersion: 2, novelId: randomUUID(), title, approvalMode, currentChapter: 1, approvedChapterEnd: 0, artifacts: {}, continuity: { lastCommittedChapter: 0, revision: 0 }, createdAt: now, updatedAt: now };
    await this.writeState(state);
    return state;
  }

  async get(novelId: string): Promise<NovelState> {
    try { return novelStateSchema.parse(parse(await readFile(this.statePath(novelId), "utf8"))); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError("NOVEL_NOT_FOUND", "没有找到这部作品。", 404, false); }
  }

  async list(): Promise<NovelSummary[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const novels = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try { const state = await this.get(entry.name); const fileStat = await stat(this.statePath(entry.name)); return { id: state.novelId, title: state.title, updatedAt: state.updatedAt ?? fileStat.mtime.toISOString(), nextStep: decideNextAction(state).type } satisfies NovelSummary; }
      catch { return undefined; }
    }));
    return novels.filter((novel): novel is NonNullable<typeof novel> => novel !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveOpeningChoices(novelId: string, choices: unknown): Promise<NovelState> {
    const state = await this.prepareForWrite(await this.get(novelId));
    const { workingTitle, ...openingChoices } = openingChoicesInputSchema.parse(choices);
    state.openingChoices = openingChoices;
    if (workingTitle?.trim()) state.title = workingTitle.trim();
    this.invalidateDependents(state, [artifactKey("novel_brief")]);
    await this.touchAndWrite(state);
    return state;
  }

  async setChapterRange(novelId: string, start: number, end: number): Promise<NovelState> {
    const state = await this.prepareForWrite(await this.get(novelId));
    if (start !== state.currentChapter) throw new AppError("CHAPTER_RANGE_STALE", `当前应从第 ${state.currentChapter} 章开始。`, 409, true);
    state.approvedChapterEnd = end;
    await this.touchAndWrite(state);
    return state;
  }

  async setActiveRun(novelId: string, runId?: string): Promise<void> {
    const state = await this.prepareForWrite(await this.get(novelId));
    state.activeRunId = runId;
    await this.touchAndWrite(state);
  }

  async listArtifacts(novelId: string): Promise<ArtifactState[]> {
    const state = await this.get(novelId);
    return Object.entries(state.artifacts).map(([key, item]) => ({ ...item, key: item.key ?? key, source: item.source ?? (item.userEdited ? "user_edited" : "ai_generated"), dependsOn: item.dependsOn ?? [] }));
  }

  async readArtifact(novelId: string, key: string): Promise<{ artifact: ArtifactState; content: string }> {
    const state = await this.get(novelId);
    const artifact = state.artifacts[key];
    if (!artifact) throw new AppError("ARTIFACT_NOT_FOUND", "没有找到这个工件。", 404, false);
    return { artifact: { ...artifact, key }, content: await readFile(this.artifactPath(novelId, artifact.path), "utf8") };
  }

  async commitProposal(args: { novelId: string; proposal: ArtifactProposal; expectedInputHash: string; promptVersion: string; idempotencyKey: string; dependsOn?: string[] }): Promise<{ state: NovelState; sha256: string; duplicate: boolean }> {
    const state = await this.prepareForWrite(await this.get(args.novelId));
    const proposal = artifactProposalSchema.parse(args.proposal);
    const dependencies = args.dependsOn ?? [];
    const expectedKey = `${args.novelId}:${proposal.artifactKey}:${args.expectedInputHash}:${args.promptVersion}`;
    if (args.idempotencyKey !== expectedKey) throw new AppError("INVALID_IDEMPOTENCY_KEY", "提交标识无效。", 400, false);
    if (novelInputHash(state, dependencies) !== args.expectedInputHash) throw new AppError("CONTEXT_STALE", "上游内容已经改变，请重新生成。", 409, true);
    const existing = state.artifacts[proposal.artifactKey];
    if (existing?.protected) throw new AppError("ARTIFACT_PROTECTED", "该工件已被作者保护，需要明确解除保护后才能替换。", 409, false);
    if (existing?.status === "ready" && existing.inputHash === args.expectedInputHash && existing.promptVersion === args.promptVersion) return { state, sha256: existing.sha256 ?? "", duplicate: true };

    const files = proposal.files.length ? proposal.files : [{ path: this.defaultPath(proposal.artifactKey), content: proposal.content }];
    for (const file of files) await atomicWrite(this.artifactPath(args.novelId, file.path), file.content);
    const [main] = files;
    if (!main) throw new AppError("EMPTY_PROPOSAL", "工件提案没有可写内容。", 400, true);
    const contentHash = sha256(main.content);
    state.artifacts[proposal.artifactKey] = { key: proposal.artifactKey, stage: this.stageForKey(proposal.artifactKey), status: "ready", path: normalizeArtifactPath(main.path), source: "ai_generated", protected: false, userEdited: false, sha256: contentHash, inputHash: args.expectedInputHash, promptVersion: args.promptVersion, dependsOn: dependencies, committedAt: new Date().toISOString() };
    this.invalidateDependents(state, [proposal.artifactKey]);
    await this.touchAndWrite(state);
    return { state, sha256: contentHash, duplicate: false };
  }

  async commitBundle(args: { novelId: string; expectedInputHash: string; promptVersion: string; dependsOn: string[]; artifacts: Array<{ key: string; path: string; content: string; source?: "ai_generated" | "user_edited" | "imported" }>; continuityDelta?: { chapter: number; facts: string[]; characterStates: string[]; resources: string[]; relationships: string[]; payoffs: string[]; worldChanges: string[] } }) {
    const state = await this.prepareForWrite(await this.get(args.novelId));
    if (novelInputHash(state, args.dependsOn) !== args.expectedInputHash) throw new AppError("CONTEXT_STALE", "上游内容已经改变，请重新生成。", 409, true);
    const artifacts: Array<{ key: string; path: string; content: string; source?: "ai_generated" | "user_edited" | "imported" }> = [...args.artifacts, ...(args.continuityDelta ? await this.continuityArtifacts(args.novelId, args.continuityDelta) : [])];
    for (const item of artifacts) if (state.artifacts[item.key]?.protected) throw new AppError("ARTIFACT_PROTECTED", `工件 ${item.key} 已被作者保护。`, 409, false);
    for (const item of artifacts) await atomicWrite(this.artifactPath(args.novelId, item.path), item.content);
    const committedAt = new Date().toISOString();
    for (const item of artifacts) state.artifacts[item.key] = { key: item.key, stage: this.stageForKey(item.key), path: normalizeArtifactPath(item.path), status: "ready", source: item.source ?? "ai_generated", protected: false, sha256: sha256(item.content), inputHash: args.expectedInputHash, promptVersion: args.promptVersion, dependsOn: args.dependsOn, committedAt };
    const continuity = artifacts.find((item) => item.key.endsWith(":continuity_update"));
    if (continuity) {
      const chapter = Number(continuity.key.split(":")[1]);
      state.continuity = { lastCommittedChapter: chapter, revision: (state.continuity?.revision ?? 0) + 1 };
      state.currentChapter = chapter + 1;
    }
    await this.touchAndWrite(state);
    if (args.continuityDelta) this.rebuildContinuityIndex(args.novelId, args.continuityDelta.chapter);
    return { state, sha256: sha256(artifacts.map((item) => item.content).join("\n")) };
  }

  async exportStableChapters(novelId: string, fileName?: string) {
    const state = await this.prepareForWrite(await this.get(novelId));
    const chapters = Object.entries(state.artifacts)
      .filter(([key, item]) => /^chapter:\d+:humanization_revision$/.test(key) && item.status === "ready")
      .sort(([a], [b]) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
    if (!chapters.length) throw new AppError("NO_STABLE_CHAPTERS", "目前没有可导出的稳定章节。", 409, true);
    const parts = await Promise.all(chapters.map(async ([key, item]) => `第${Number(key.split(":")[1])}章\n\n${await readFile(this.artifactPath(novelId, item.path), "utf8")}`));
    const safeName = (fileName?.trim() || state.title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80);
    const relativePath = `exports/${safeName}.txt`;
    const content = `${parts.join("\n\n")}\n`;
    await atomicWrite(this.artifactPath(novelId, relativePath), content);
    const key = `export:${safeName}`;
    state.artifacts[key] = { key, path: relativePath, status: "ready", source: "ai_generated", protected: false, sha256: sha256(content), dependsOn: chapters.map(([chapterKey]) => chapterKey), committedAt: new Date().toISOString() };
    await this.touchAndWrite(state);
    return { path: relativePath, chapterCount: chapters.length, sha256: sha256(content) };
  }

  async readExport(novelId: string, relativePath: string) {
    const state = await this.get(novelId);
    const artifact = Object.values(state.artifacts).find((item) => item.path === relativePath && item.path.startsWith("exports/") && item.status === "ready");
    if (!artifact) throw new AppError("EXPORT_NOT_FOUND", "没有找到这个导出文件。", 404, false);
    return { content: await readFile(this.artifactPath(novelId, artifact.path), "utf8"), fileName: path.basename(artifact.path) };
  }

  async appendQualityDebt(novelId: string, chapter: number, items: string[]) {
    if (!items.length) return;
    const target = this.artifactPath(novelId, "production/quality-debt.md");
    let current = "# 质量债\n";
    try { current = await readFile(target, "utf8"); } catch { /* first debt entry */ }
    const section = `\n## 第 ${chapter} 章 · ${new Date().toISOString()}\n\n${items.map((item) => `- [open] ${item}`).join("\n")}\n`;
    await atomicWrite(target, `${current.trimEnd()}\n${section}`);
  }

  async commitBrief(args: { novelId: string; brief: NovelBrief; expectedInputHash: string; idempotencyKey: string }) {
    const brief = novelBriefSchema.parse(args.brief);
    const result = await this.commitProposal({ novelId: args.novelId, proposal: { artifactKey: artifactKey("novel_brief"), title: "小说简报", format: "markdown", content: renderNovelBrief(brief), files: [{ path: BRIEF_PATH, content: renderNovelBrief(brief) }], metadata: { structured: brief } }, expectedInputHash: args.expectedInputHash, promptVersion, idempotencyKey: args.idempotencyKey });
    if (result.state.title === untitledNovelTitle) { result.state.title = brief.workingTitle; await this.touchAndWrite(result.state); }
    return result;
  }

  async editArtifact(novelId: string, key: string, content: string, expectedSha256: string) {
    const state = await this.prepareForWrite(await this.get(novelId));
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status !== "ready") throw new AppError("ARTIFACT_NOT_READY", "工件尚未保存。", 409, true);
    if (artifact.sha256 !== expectedSha256) throw new AppError("ARTIFACT_CONFLICT", "工件已被修改，请刷新后重试。", 409, true);
    const contentHash = sha256(content);
    await atomicWrite(this.artifactPath(novelId, artifact.path), content);
    Object.assign(artifact, { sha256: contentHash, source: "user_edited" as const, userEdited: true, protected: true, committedAt: new Date().toISOString() });
    this.invalidateDependents(state, [key]);
    await this.touchAndWrite(state);
    return { state, sha256: contentHash };
  }

  async editCommittedBrief(novelId: string, brief: NovelBrief, expectedSha256: string) {
    return this.editArtifact(novelId, artifactKey("novel_brief"), renderNovelBrief(novelBriefSchema.parse(brief)), expectedSha256);
  }

  private defaultPath(key: string): string {
    if (key === "book:novel_brief") return BRIEF_PATH;
    if (key === "book:story_bible") return "story-bible.md";
    if (key === "book:world_bible") return "world-bible.md";
    if (key === "book:character_cast") return "characters/character-roster.md";
    if (key === "book:volume_strategy") return "volumes/volume-strategy.md";
    if (key === "book:volume_outline") return "volumes/volume-01.md";
    const match = /^chapter:(\d+):(.+)$/.exec(key);
    if (match) { const chapterNumber = match[1]; const stage = match[2]; if (!chapterNumber || !stage) throw new AppError("INVALID_ARTIFACT_KEY", "章节工件键无效。", 400, false); const chapter = chapterNumber.padStart(3, "0"); const names: Record<string, string> = { chapter_plan: "plan.md", context_package: "context-package.md", chapter_draft: "draft.md", humanization_revision: "draft-humanized.md", chapter_review: "review.md", continuity_update: "continuity-delta.yaml" }; return `chapters/chapter-${chapter}/${names[stage] ?? `${stage}.md`}`; }
    if (key.startsWith("export:")) return `exports/${key.slice(7)}.txt`;
    throw new AppError("INVALID_ARTIFACT_KEY", "未知工件类型。", 400, false);
  }

  private stageForKey(key: string): ProductionStage | undefined {
    const name = key.split(":").at(-1) as ProductionStage;
    return ["novel_brief", "story_bible", "world_bible", "character_cast", "volume_strategy", "volume_outline", "chapter_plan", "context_package", "chapter_draft", "humanization_revision", "chapter_review", "continuity_update", "quality_repair"].includes(name) ? name : undefined;
  }

  private invalidateDependents(state: NovelState, changed: string[]) {
    const queue = [...changed];
    while (queue.length) { const upstream = queue.shift()!; for (const [key, artifact] of Object.entries(state.artifacts)) { if (key === upstream || artifact.protected || !artifact.dependsOn?.includes(upstream) || artifact.status === "stale") continue; artifact.status = "stale"; queue.push(key); } }
  }

  private async continuityArtifacts(novelId: string, delta: { chapter: number; facts: string[]; characterStates: string[]; resources: string[]; relationships: string[]; payoffs: string[]; worldChanges: string[] }) {
    const groups = { facts: delta.facts, "character-state": delta.characterStates, resources: delta.resources, relationships: delta.relationships, payoffs: delta.payoffs, "world-changes": delta.worldChanges };
    const artifacts: Array<{ key: string; path: string; content: string }> = [];
    for (const [category, values] of Object.entries(groups)) {
      const relativePath = `continuity/data/${category}.yaml`;
      let entries: Array<{ id: string; chapter: number; value: string }> = [];
      try { const parsed = parse(await readFile(this.artifactPath(novelId, relativePath), "utf8")) as { entries?: typeof entries }; entries = parsed?.entries ?? []; } catch { /* first stable chapter */ }
      const seen = new Set(entries.map((entry) => `${entry.chapter}:${entry.value}`));
      for (const value of values) if (!seen.has(`${delta.chapter}:${value}`)) entries.push({ id: `${category.toUpperCase()}-${sha256(`${delta.chapter}:${value}`).slice(0, 12)}`, chapter: delta.chapter, value });
      artifacts.push({ key: `continuity:${category}`, path: relativePath, content: stringify({ schemaVersion: 1, lastCommittedChapter: delta.chapter, entries }) });
      artifacts.push({ key: `continuity:view:${category}`, path: `continuity/${category}.md`, content: `# ${category}\n\n> 此文件由 continuity/data/${category}.yaml 生成，请勿作为事实源。\n\n${entries.map((entry) => `- [${entry.id}] 第 ${entry.chapter} 章：${entry.value}`).join("\n")}\n` });
    }
    artifacts.push({ key: "continuity:manifest", path: "continuity/data/manifest.yaml", content: stringify({ schemaVersion: 1, lastCommittedChapter: delta.chapter, updatedAt: new Date().toISOString(), authority: "continuity/data/*.yaml" }) });
    artifacts.push({ key: "production:recovery", path: "production/recovery.md", content: `# 生产恢复点\n\n- 最后稳定章节：第 ${delta.chapter} 章\n- 连续性已提交：第 ${delta.chapter} 章\n- 下一动作：规划第 ${delta.chapter + 1} 章（若仍在批准范围内）\n- 连续性权威：continuity/data/*.yaml\n- SQLite 索引：可删除、可重建；失败时回退 YAML\n` });
    return artifacts;
  }

  private rebuildContinuityIndex(novelId: string, chapter: number) {
    try {
      const database = new DatabaseSync(this.artifactPath(novelId, "continuity/index.sqlite3"));
      database.exec("CREATE TABLE IF NOT EXISTS continuity_entries (category TEXT NOT NULL, id TEXT PRIMARY KEY, chapter INTEGER NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS continuity_entries_chapter ON continuity_entries(chapter)");
      const insert = database.prepare("INSERT OR REPLACE INTO continuity_entries(category,id,chapter,value) VALUES(?,?,?,?)");
      for (const category of ["facts", "character-state", "resources", "relationships", "payoffs", "world-changes"]) {
        try { const parsed = parse(readFileSync(this.artifactPath(novelId, `continuity/data/${category}.yaml`), "utf8")) as { entries?: Array<{ id: string; chapter: number; value: string }> }; for (const entry of parsed.entries ?? []) insert.run(category, entry.id, entry.chapter, entry.value); } catch { /* YAML remains authoritative */ }
      }
      database.exec(`PRAGMA user_version = ${Math.max(1, chapter)}`);
      database.close();
    } catch { /* disposable index: YAML fallback is authoritative */ }
  }

  private async prepareForWrite(state: NovelState): Promise<NovelState> {
    if (state.schemaVersion === 2) return state;
    const source = this.statePath(state.novelId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(source, path.join(this.novelDirectory(state.novelId), `novel-state.v1-backup-${stamp}.yaml`));
    state.schemaVersion = 2;
    state.approvalMode ??= "milestone_approval";
    state.continuity ??= { lastCommittedChapter: Math.max(0, state.currentChapter - 1), revision: 0 };
    for (const [key, artifact] of Object.entries(state.artifacts)) { artifact.key ??= key; artifact.source ??= artifact.userEdited ? "user_edited" : "ai_generated"; artifact.dependsOn ??= []; }
    return state;
  }

  private async touchAndWrite(state: NovelState) { state.updatedAt = new Date().toISOString(); await this.writeState(state); }
  private async writeState(state: NovelState): Promise<void> { novelStateSchema.parse(state); await atomicWrite(this.statePath(state.novelId), stringify(state, { lineWidth: 0 })); }
}
