import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { AppError } from "../application/errors";
import { chapterManifestSchema, chapterParserConfigSchema, chapterRangeSchema, libraryStateSchema, MAX_REFERENCE_TOKEN_BUDGET, MIN_REFERENCE_TOKEN_BUDGET, referenceAnalysisPresetSections, referenceAnalysisSchema, referenceCharacterProfileSchema, referenceSectionSchema, referenceStateSchema, tokenEstimateSchema, type ChapterManifest, type ChapterManifestItem, type ChapterParserConfig, type ChapterRange, type DeconstructionFocus, type DeconstructionMode, type ReferenceAnalysis, type ReferenceAnalysisPreset, type ReferenceCharacterProfile, type ReferenceSection, type ReferenceState } from "../domain";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const TARGET_CHARS = 8_000;
export const referenceSha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

async function atomicWrite(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

export function decodeReferenceSource(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new AppError("REFERENCE_SIZE_INVALID", "参考书必须是 1 字节到 20MiB 的文本文件。", 413, false);
  let encoding: "utf-8" | "gb18030" = "utf-8";
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { encoding = "gb18030"; try { content = new TextDecoder("gb18030", { fatal: true }).decode(bytes); } catch { throw new AppError("REFERENCE_ENCODING_INVALID", "无法按 UTF-8 或 GB18030 解码参考书。", 400, false); } }
  content = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\0", "").trimEnd() + "\n";
  if (!content.trim()) throw new AppError("REFERENCE_EMPTY", "参考书没有可分析的文字。", 400, false);
  return { content, encoding };
}

type Boundary = { start: number; title: string; volume?: string };
const chapterNumber = "0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟";
const volumePrefix = new RegExp(`^(?:第\\s*[${chapterNumber}]{1,16}\\s*[卷部]|[卷部]\\s*[${chapterNumber}]{1,16})(?:\\s*[:：.、_—-]\\s*)?`, "i");
export const DEFAULT_CHAPTER_PARSER = chapterParserConfigSchema.parse({
  version: 1,
  patterns: [
    { id: "numbered-chapter", name: "数字与中文章回", pattern: `^(?:正文\\s*)?[【\\[（(]?\\s*(?:(?:第\\s*)?[${chapterNumber}]{1,16}\\s*[章节回话]|(?:chapter|chap\\.?|ch\\.?)\\s*[0-9ivxlcdm]+)(?:\\s*[:：.、_—-]\\s*)?`, enabled: true, source: "builtin" },
    { id: "named-section", name: "序章、番外与尾声", pattern: "^(?:序章|楔子|引子|尾声|后记|番外(?:[0-9０-９零〇一二两三四五六七八九十百千万]+)?)(?:\\s*[:：.、_—-]|\\s|$)", enabled: true, source: "builtin" },
  ],
});
function conciseHeading(value: string) {
  const clean = value.trim().replace(/^[【\[（(]\s*/, "").replace(/\s*[】\]）)]$/, "");
  const sentenceEnd = clean.search(/[。！？!?]/);
  const title = sentenceEnd >= 0 ? clean.slice(0, sentenceEnd) : clean;
  return title.length > 80 ? `${title.slice(0, 80).trimEnd()}…` : title;
}
function headingBoundaries(content: string, parser: ChapterParserConfig) {
  const chapterPatterns = parser.patterns.filter((item) => item.enabled).map((item) => new RegExp(item.pattern, "iu"));
  const result: Boundary[] = []; let offset = 0; let volume: string | undefined; let pendingVolumeStart: number | undefined;
  for (const line of content.split(/(?<=\n)/)) {
    const text = line.replace(/\n$/, "").trim();
    const markdown = text.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
    const candidate = markdown ?? text;
    const volumeHeading = volumePrefix.test(candidate);
    const chapterHeading = chapterPatterns.some((pattern) => pattern.test(candidate.slice(0, 160))) || Boolean(markdown && !volumeHeading);
    if (volumeHeading) { volume = conciseHeading(candidate); pendingVolumeStart = offset; }
    else if (chapterHeading) { result.push({ start: pendingVolumeStart ?? offset, title: conciseHeading(candidate), ...(volume ? { volume } : {}) }); pendingVolumeStart = undefined; }
    offset += line.length;
  }
  return result;
}

function fixedRanges(content: string, target = TARGET_CHARS) {
  const ranges: Array<{ start: number; end: number }> = []; let start = 0;
  while (start < content.length) {
    if (content.length - start <= target) { ranges.push({ start, end: content.length }); break; }
    const min = start + Math.floor(target * .8); const max = Math.min(content.length, start + Math.floor(target * 1.2));
    let end = content.indexOf("\n\n", min); if (end < 0 || end > max) end = content.lastIndexOf("\n", max); if (end <= start) end = Math.min(content.length, start + target);
    else end += content.startsWith("\n\n", end) ? 2 : 1;
    ranges.push({ start, end }); start = end;
  }
  return ranges;
}

export function buildChapterManifest(content: string, sourceHash: string, targetChars = TARGET_CHARS, parser = DEFAULT_CHAPTER_PARSER): ChapterManifest {
  const boundaries = headingBoundaries(content, chapterParserConfigSchema.parse(parser));
  const chapters: ChapterManifestItem[] = [];
  if (boundaries.length >= 3) {
    const frontmatter = content.slice(0, boundaries[0]!.start).trim();
    if (boundaries[0]!.start > 0 && /[\p{L}\p{N}]/u.test(frontmatter)) chapters.push({ id: "chapter-0001", index: 0, title: "前言", start: 0, end: boundaries[0]!.start, kind: "frontmatter" });
    boundaries.forEach((boundary, index) => chapters.push({ id: `chapter-${String(chapters.length + 1).padStart(4, "0")}`, index: chapters.length, title: boundary.title, start: boundary.start, end: boundaries[index + 1]?.start ?? content.length, ...(boundary.volume ? { volume: boundary.volume } : {}), kind: "chapter" }));
  } else fixedRanges(content, targetChars).forEach((range, index) => chapters.push({ id: `chapter-${String(index + 1).padStart(4, "0")}`, index, title: `片段 ${index + 1}`, ...range, kind: "chapter" }));
  const draft = { version: 1 as const, sourceHash, method: boundaries.length >= 3 ? "headings" as const : "fixed" as const, targetChars, totalChars: content.length, chapters, generatedAt: now() };
  const digest = referenceSha256(stringify(draft, { lineWidth: 0 }));
  return chapterManifestSchema.parse({ ...draft, sha256: digest });
}

export function referenceChaptersInRange(manifest: ChapterManifest, rawRange?: ChapterRange) {
  if (!rawRange) return manifest.chapters;
  const range = chapterRangeSchema.parse(rawRange);
  if (range.toChapter > manifest.chapters.length) throw new AppError("REFERENCE_RANGE_INVALID", `拆书范围不能超过第 ${manifest.chapters.length} 章。`, 400, false);
  return manifest.chapters.slice(range.fromChapter - 1, range.toChapter);
}

export function estimateDeconstruction(manifest: ChapterManifest, mode: DeconstructionMode, focuses: DeconstructionFocus[], chapterRange?: ChapterRange, preset: ReferenceAnalysisPreset = "standard") {
  const chapters = referenceChaptersInRange(manifest, chapterRange);
  const chars = chapters.reduce((sum, chapter) => sum + chapter.end - chapter.start, 0); const calls = Math.max(1, Math.ceil(chars / 18_000)); const scans = 1 + (mode === "deep" ? focuses.length : 0);
  const inputMin = Math.ceil((chars * .8 + calls * 500) * scans + chars * .1); const inputMax = Math.ceil((chars * 1.3 + calls * 900) * scans + chars * .35);
  const sectionCount = referenceAnalysisPresetSections[preset].length;
  const outputMin = Math.ceil(chapters.length * 220 * scans + calls * 250 + sectionCount * 700); const outputMax = Math.ceil(chapters.length * 650 * scans + calls * 600 + sectionCount * 2_000);
  const segments = Math.ceil(chapters.length / 25);
  return tokenEstimateSchema.parse({ calls: calls * scans + segments + Math.ceil(segments / 4) + sectionCount, inputMin, inputMax: inputMax + sectionCount * 4_000, outputMin, outputMax, recommendedBudget: Math.max(MIN_REFERENCE_TOKEN_BUDGET, Math.min(MAX_REFERENCE_TOKEN_BUDGET, Math.ceil((inputMax + sectionCount * 4_000 + outputMax) * 1.2))) });
}

export class ReferenceRepository {
  readonly root: string;
  constructor(root = path.resolve(process.env.ANI_REFERENCE_LIBRARY_DIR ?? process.env.INIT_CWD ?? process.cwd(), process.env.ANI_REFERENCE_LIBRARY_DIR ? "" : "reference-library")) { this.root = root; }
  private dir(id: string) { const value = referenceStateSchema.shape.referenceId.parse(id); const target = path.resolve(this.root, value); if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new AppError("REFERENCE_NOT_FOUND", "没有找到这本参考书。", 404, false); return target; }
  private sourcePath(id: string) { return path.join(this.dir(id), "source", "original.txt"); }
  private manifestPath(id: string) { return path.join(this.dir(id), "source", "chapters.yaml"); }
  private parserPath(id: string) { return path.join(this.dir(id), "source", "parser.yaml"); }
  private statePath(id: string) { return path.join(this.dir(id), "reference-state.yaml"); }
  private libraryPath() { return path.join(this.root, "library-state.yaml"); }
  analysisDir(id: string, analysisId: string) { if (!/^[a-zA-Z0-9-]+$/.test(analysisId)) throw new AppError("REFERENCE_PATH_INVALID", "分析路径无效。", 400, false); return path.join(this.dir(id), "analyses", analysisId); }
  async init() { await mkdir(this.root, { recursive: true }); if (!(await stat(this.libraryPath()).catch(() => undefined))) await atomicWrite(this.libraryPath(), stringify({ version: 1, updatedAt: now() })); }
  async libraryState() { await this.init(); return libraryStateSchema.parse(parse(await readFile(this.libraryPath(), "utf8"))); }
  async setActive(jobId?: string, referenceId?: string) { const state = await this.libraryState(); const next = libraryStateSchema.parse({ ...state, activeJobId: jobId, activeReferenceId: referenceId, updatedAt: now() }); await atomicWrite(this.libraryPath(), stringify(next)); return next; }
  async import(input: { fileName: string; title?: string; bytes: Buffer }) {
    if (!/\.(?:txt|md|markdown)$/i.test(input.fileName)) throw new AppError("REFERENCE_TYPE_INVALID", "第一版只支持 TXT 和 Markdown。", 400, false);
    await this.init(); const { content, encoding } = decodeReferenceSource(input.bytes); const sourceHash = referenceSha256(content);
    for (const item of await this.list()) if (item.source.sha256 === sourceHash) return { state: await this.get(item.referenceId), manifest: await this.manifest(item.referenceId), duplicate: true };
    const referenceId = randomUUID(); const manifest = buildChapterManifest(content, sourceHash); const timestamp = now();
    const state = referenceStateSchema.parse({ version: 1, referenceId, title: input.title?.trim() || input.fileName.replace(/\.(?:txt|md|markdown)$/i, ""), source: { fileName: input.fileName, encoding, sizeBytes: input.bytes.length, chars: content.length, sha256: sourceHash, importedAt: timestamp }, manifestHash: manifest.sha256, manifestConfirmed: false, analyses: [], updatedAt: timestamp });
    await mkdir(this.dir(referenceId), { recursive: false }); await Promise.all([atomicWrite(this.sourcePath(referenceId), content), atomicWrite(this.manifestPath(referenceId), stringify(manifest, { lineWidth: 0 })), atomicWrite(this.parserPath(referenceId), stringify(DEFAULT_CHAPTER_PARSER, { lineWidth: 0 })), atomicWrite(this.statePath(referenceId), stringify(state, { lineWidth: 0 }))]);
    return { state, manifest, duplicate: false };
  }
  async list(): Promise<ReferenceState[]> { await this.init(); const entries = await readdir(this.root, { withFileTypes: true }); const states = await Promise.all(entries.filter((item) => item.isDirectory()).map((item) => this.get(item.name).catch(() => undefined))); return states.filter((item): item is ReferenceState => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async get(id: string) { try { return referenceStateSchema.parse(parse(await readFile(this.statePath(id), "utf8"))); } catch (error) { if (error instanceof AppError) throw error; throw new AppError("REFERENCE_NOT_FOUND", "没有找到这本参考书。", 404, false); } }
  async manifest(id: string) { return chapterManifestSchema.parse(parse(await readFile(this.manifestPath(id), "utf8"))); }
  async parser(id: string) { await this.get(id); return readFile(this.parserPath(id), "utf8").then((value) => chapterParserConfigSchema.parse(parse(value))).catch(() => DEFAULT_CHAPTER_PARSER); }
  async source(id: string) { await this.get(id); return readFile(this.sourcePath(id), "utf8"); }
  async sourceSlice(id: string, start: number, end: number) { const source = await this.source(id); if (start < 0 || end <= start || end > source.length) throw new AppError("REFERENCE_RANGE_INVALID", "原文读取范围无效。", 400, false); return { start, end, content: source.slice(start, end) }; }
  async rebuildManifest(id: string) {
    const [state, source, parser] = await Promise.all([this.get(id), this.source(id), this.parser(id)]);
    const manifest = buildChapterManifest(source, state.source.sha256, TARGET_CHARS, parser);
    const changed = manifest.sha256 !== state.manifestHash;
    const analyses = state.analyses.map((analysis) => changed ? referenceAnalysisSchema.parse({ ...analysis, stale: true, staleReasons: [...new Set([...analysis.staleReasons, "manifest" as const])] }) : analysis);
    const next = referenceStateSchema.parse({ ...state, manifestHash: manifest.sha256, manifestConfirmed: changed ? false : state.manifestConfirmed, analyses, updatedAt: now() });
    await Promise.all([atomicWrite(this.manifestPath(id), stringify(manifest, { lineWidth: 0 })), atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 }))]);
    return { state: next, manifest, parser };
  }
  async saveParser(id: string, input: unknown) { await this.get(id); const parser = chapterParserConfigSchema.parse(input); await atomicWrite(this.parserPath(id), stringify(parser, { lineWidth: 0 })); return parser; }
  async confirmManifest(id: string, expectedHash: string) { const state = await this.get(id); const manifest = await this.manifest(id); if (manifest.sha256 !== expectedHash || state.manifestHash !== expectedHash) throw new AppError("REFERENCE_MANIFEST_STALE", "章节切分已经变化，请重新确认。", 409, true); const confirmed = chapterManifestSchema.parse({ ...manifest, confirmedAt: now() }); await atomicWrite(this.manifestPath(id), stringify(confirmed, { lineWidth: 0 })); const next = referenceStateSchema.parse({ ...state, manifestConfirmed: true, updatedAt: now() }); await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 })); return { state: next, manifest: confirmed }; }
  async delete(id: string) { const library = await this.libraryState(); if (library.activeReferenceId === id) throw new AppError("REFERENCE_ACTIVE", "这本参考书正在拆解，不能删除。", 409, true); await this.get(id); await rm(this.dir(id), { recursive: true, force: false }); }
  async clearAnalyses(id: string) {
    const library = await this.libraryState();
    if (library.activeJobId) throw new AppError("REFERENCE_ACTIVE", "存在运行中的拆书任务，不能清理分析结果。", 409, true);
    const state = await this.get(id);
    await rm(path.join(this.dir(id), "analyses"), { recursive: true, force: true });
    const next = referenceStateSchema.parse({ ...state, analyses: [], latestAnalysisId: undefined, updatedAt: now() });
    await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 }));
    return next;
  }
  async updateAnalysis(id: string, analysis: ReferenceAnalysis) { const state = await this.get(id); const parsed = referenceAnalysisSchema.parse(analysis); const analyses = [...state.analyses.filter((item) => item.id !== parsed.id), parsed]; const next = referenceStateSchema.parse({ ...state, analyses, latestAnalysisId: parsed.status === "completed" ? parsed.id : state.latestAnalysisId, updatedAt: now() }); await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 })); return next; }
  async propagateStale(id: string, sourceHash: string, manifestHash: string, promptVersion: string) { const state = await this.get(id); const analyses = state.analyses.map((analysis) => { const staleReasons = [...(analysis.sourceHash !== sourceHash ? ["source" as const] : []), ...(analysis.manifestHash !== manifestHash ? ["manifest" as const] : []), ...(analysis.promptVersion !== promptVersion ? ["prompt" as const] : [])]; return referenceAnalysisSchema.parse({ ...analysis, stale: staleReasons.length > 0, staleReasons }); }); const next = referenceStateSchema.parse({ ...state, analyses, updatedAt: now() }); await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 })); return next; }
  async writeAnalysisFile(id: string, analysisId: string, relative: string, content: string) { if (!/^(?:batches|segments|chapters|focus|sections)\/[a-zA-Z0-9_-]+\.(?:ya?ml|md)$|^characters\/[a-zA-Z0-9%-]+\.yaml$|^(?:index\.yaml|report\.md)$/.test(relative)) throw new AppError("REFERENCE_PATH_INVALID", "分析文件路径无效。", 400, false); const target = path.join(this.analysisDir(id, analysisId), relative); await atomicWrite(target, content); return target; }
  async readAnalysisFile(id: string, analysisId: string, relative: string, maxChars = 80_000) { const root = this.analysisDir(id, analysisId); const target = path.resolve(root, relative); if (!target.startsWith(`${root}${path.sep}`) || !/\.(?:md|ya?ml)$/.test(target)) throw new AppError("REFERENCE_PATH_INVALID", "分析文件路径无效。", 400, false); const content = await readFile(target, "utf8").catch(() => { throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到这份拆书结果。", 404, false); }); return content.slice(0, maxChars); }
  async listAnalysisFiles(id: string, analysisId: string, directory: "batches" | "segments" | "chapters" | "focus") { const root = path.join(this.analysisDir(id, analysisId), directory); return (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((item) => item.isFile()).map((item) => `${directory}/${item.name}`).sort(); }
  async section(id: string, analysisId: string, key: string): Promise<ReferenceSection> { return referenceSectionSchema.parse(parse(await this.readAnalysisFile(id, analysisId, `sections/${key}.yaml`, 200_000))); }
  async sections(id: string, analysisId: string) { const files = await readdir(path.join(this.analysisDir(id, analysisId), "sections"), { withFileTypes: true }).catch(() => []); return Promise.all(files.filter((item) => item.isFile() && item.name.endsWith(".yaml")).map((item) => this.section(id, analysisId, item.name.replace(/\.yaml$/, "")).catch(() => undefined))).then((items) => items.filter((item): item is ReferenceSection => Boolean(item))); }
  async character(id: string, analysisId: string, name: string): Promise<ReferenceCharacterProfile> { return referenceCharacterProfileSchema.parse(parse(await this.readAnalysisFile(id, analysisId, `characters/${encodeURIComponent(name)}.yaml`, 200_000))); }
}
