import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { AppError } from "../application/errors";
import { chapterManifestSchema, libraryStateSchema, MAX_REFERENCE_TOKEN_BUDGET, MIN_REFERENCE_TOKEN_BUDGET, referenceAnalysisSchema, referenceStateSchema, tokenEstimateSchema, type ChapterManifest, type ChapterManifestItem, type DeconstructionFocus, type DeconstructionMode, type ReferenceAnalysis, type ReferenceState } from "../domain";

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
function headingBoundaries(content: string) {
  const result: Boundary[] = []; let offset = 0; let volume: string | undefined; let pendingVolumeStart: number | undefined;
  for (const line of content.split(/(?<=\n)/)) {
    const text = line.replace(/\n$/, "").trim();
    const markdown = text.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
    const candidate = markdown ?? text;
    const volumeHeading = /^第[\d零〇一二两三四五六七八九十百千万]+[卷部].*$/i.test(candidate);
    const chapterHeading = /^第[\d零〇一二两三四五六七八九十百千万]+[章节回].*$/i.test(candidate) || /^chapter\s+[\divxlcdm]+\b.*$/i.test(candidate) || Boolean(markdown && !volumeHeading);
    if (volumeHeading) { volume = candidate; pendingVolumeStart = offset; }
    else if (chapterHeading) { result.push({ start: pendingVolumeStart ?? offset, title: candidate, ...(volume ? { volume } : {}) }); pendingVolumeStart = undefined; }
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

export function buildChapterManifest(content: string, sourceHash: string, targetChars = TARGET_CHARS): ChapterManifest {
  const boundaries = headingBoundaries(content);
  const chapters: ChapterManifestItem[] = [];
  if (boundaries.length >= 3) {
    if (boundaries[0]!.start > 0 && content.slice(0, boundaries[0]!.start).trim()) chapters.push({ id: "chapter-0001", index: 0, title: "前言", start: 0, end: boundaries[0]!.start, kind: "frontmatter" });
    boundaries.forEach((boundary, index) => chapters.push({ id: `chapter-${String(chapters.length + 1).padStart(4, "0")}`, index: chapters.length, title: boundary.title, start: boundary.start, end: boundaries[index + 1]?.start ?? content.length, ...(boundary.volume ? { volume: boundary.volume } : {}), kind: "chapter" }));
  } else fixedRanges(content, targetChars).forEach((range, index) => chapters.push({ id: `chapter-${String(index + 1).padStart(4, "0")}`, index, title: `片段 ${index + 1}`, ...range, kind: "chapter" }));
  const draft = { version: 1 as const, sourceHash, method: boundaries.length >= 3 ? "headings" as const : "fixed" as const, targetChars, totalChars: content.length, chapters, generatedAt: now() };
  const digest = referenceSha256(stringify(draft, { lineWidth: 0 }));
  return chapterManifestSchema.parse({ ...draft, sha256: digest });
}

export function estimateDeconstruction(manifest: ChapterManifest, mode: DeconstructionMode, focuses: DeconstructionFocus[]) {
  const chars = manifest.totalChars; const calls = Math.max(1, Math.ceil(chars / 18_000)); const scans = 1 + (mode === "deep" ? focuses.length : 0);
  const inputMin = Math.ceil((chars * .8 + calls * 500) * scans + chars * .1); const inputMax = Math.ceil((chars * 1.3 + calls * 900) * scans + chars * .35);
  const outputMin = Math.ceil(manifest.chapters.length * 220 * scans + calls * 250); const outputMax = Math.ceil(manifest.chapters.length * 650 * scans + calls * 600);
  const segments = Math.ceil(manifest.chapters.length / 25);
  return tokenEstimateSchema.parse({ calls: calls * scans + segments + Math.ceil(segments / 4) + 3, inputMin, inputMax, outputMin, outputMax, recommendedBudget: Math.max(MIN_REFERENCE_TOKEN_BUDGET, Math.min(MAX_REFERENCE_TOKEN_BUDGET, Math.ceil((inputMax + outputMax) * 1.2))) });
}

export class ReferenceRepository {
  readonly root: string;
  constructor(root = path.resolve(process.env.ANI_REFERENCE_LIBRARY_DIR ?? process.env.INIT_CWD ?? process.cwd(), process.env.ANI_REFERENCE_LIBRARY_DIR ? "" : "reference-library")) { this.root = root; }
  private dir(id: string) { const value = referenceStateSchema.shape.referenceId.parse(id); const target = path.resolve(this.root, value); if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new AppError("REFERENCE_NOT_FOUND", "没有找到这本参考书。", 404, false); return target; }
  private sourcePath(id: string) { return path.join(this.dir(id), "source", "original.txt"); }
  private manifestPath(id: string) { return path.join(this.dir(id), "source", "chapters.yaml"); }
  private statePath(id: string) { return path.join(this.dir(id), "reference-state.yaml"); }
  private libraryPath() { return path.join(this.root, "library-state.yaml"); }
  analysisDir(id: string, analysisId: string) { if (!/^[a-zA-Z0-9-]+$/.test(analysisId)) throw new AppError("REFERENCE_PATH_INVALID", "分析路径无效。", 400, false); return path.join(this.dir(id), "analyses", analysisId); }
  async init() { await mkdir(this.root, { recursive: true }); if (!(await stat(this.libraryPath()).catch(() => undefined))) await atomicWrite(this.libraryPath(), stringify({ version: 1, updatedAt: now() })); }
  async libraryState() { await this.init(); return libraryStateSchema.parse(parse(await readFile(this.libraryPath(), "utf8"))); }
  async setActive(jobId?: string, referenceId?: string) { const state = await this.libraryState(); const next = libraryStateSchema.parse({ ...state, activeJobId: jobId, activeReferenceId: referenceId, updatedAt: now() }); await atomicWrite(this.libraryPath(), stringify(next)); return next; }
  async import(input: { fileName: string; title?: string; bytes: Buffer; rightsConfirmed: boolean }) {
    if (!input.rightsConfirmed) throw new AppError("REFERENCE_RIGHTS_REQUIRED", "请确认你有权分析并在本地保存这份材料。", 400, false);
    if (!/\.(?:txt|md|markdown)$/i.test(input.fileName)) throw new AppError("REFERENCE_TYPE_INVALID", "第一版只支持 TXT 和 Markdown。", 400, false);
    await this.init(); const { content, encoding } = decodeReferenceSource(input.bytes); const sourceHash = referenceSha256(content);
    for (const item of await this.list()) if (item.source.sha256 === sourceHash) return { state: await this.get(item.referenceId), manifest: await this.manifest(item.referenceId), duplicate: true };
    const referenceId = randomUUID(); const manifest = buildChapterManifest(content, sourceHash); const timestamp = now();
    const state = referenceStateSchema.parse({ version: 1, referenceId, title: input.title?.trim() || input.fileName.replace(/\.(?:txt|md|markdown)$/i, ""), source: { fileName: input.fileName, encoding, sizeBytes: input.bytes.length, chars: content.length, sha256: sourceHash, importedAt: timestamp, rightsConfirmed: true }, manifestHash: manifest.sha256, manifestConfirmed: false, analyses: [], updatedAt: timestamp });
    await mkdir(this.dir(referenceId), { recursive: false }); await Promise.all([atomicWrite(this.sourcePath(referenceId), content), atomicWrite(this.manifestPath(referenceId), stringify(manifest, { lineWidth: 0 })), atomicWrite(this.statePath(referenceId), stringify(state, { lineWidth: 0 }))]);
    return { state, manifest, duplicate: false };
  }
  async list(): Promise<ReferenceState[]> { await this.init(); const entries = await readdir(this.root, { withFileTypes: true }); const states = await Promise.all(entries.filter((item) => item.isDirectory()).map((item) => this.get(item.name).catch(() => undefined))); return states.filter((item): item is ReferenceState => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async get(id: string) { try { return referenceStateSchema.parse(parse(await readFile(this.statePath(id), "utf8"))); } catch (error) { if (error instanceof AppError) throw error; throw new AppError("REFERENCE_NOT_FOUND", "没有找到这本参考书。", 404, false); } }
  async manifest(id: string) { return chapterManifestSchema.parse(parse(await readFile(this.manifestPath(id), "utf8"))); }
  async source(id: string) { await this.get(id); return readFile(this.sourcePath(id), "utf8"); }
  async sourceSlice(id: string, start: number, end: number) { const source = await this.source(id); if (start < 0 || end <= start || end - start > 40_000 || end > source.length) throw new AppError("REFERENCE_RANGE_INVALID", "原文读取范围无效或超过 40,000 字符。", 400, false); return { start, end, content: source.slice(start, end) }; }
  async confirmManifest(id: string, expectedHash: string) { const state = await this.get(id); const manifest = await this.manifest(id); if (manifest.sha256 !== expectedHash || state.manifestHash !== expectedHash) throw new AppError("REFERENCE_MANIFEST_STALE", "章节切分已经变化，请重新确认。", 409, true); const confirmed = chapterManifestSchema.parse({ ...manifest, confirmedAt: now() }); await atomicWrite(this.manifestPath(id), stringify(confirmed, { lineWidth: 0 })); const next = referenceStateSchema.parse({ ...state, manifestConfirmed: true, updatedAt: now() }); await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 })); return { state: next, manifest: confirmed }; }
  async delete(id: string) { const library = await this.libraryState(); if (library.activeReferenceId === id) throw new AppError("REFERENCE_ACTIVE", "这本参考书正在拆解，不能删除。", 409, true); await this.get(id); await rm(this.dir(id), { recursive: true, force: false }); }
  async updateAnalysis(id: string, analysis: ReferenceAnalysis) { const state = await this.get(id); const parsed = referenceAnalysisSchema.parse(analysis); const analyses = [...state.analyses.filter((item) => item.id !== parsed.id), parsed]; const next = referenceStateSchema.parse({ ...state, analyses, latestAnalysisId: parsed.status === "completed" ? parsed.id : state.latestAnalysisId, updatedAt: now() }); await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 })); return next; }
  async propagateStale(id: string, sourceHash: string, manifestHash: string, promptVersion: string) { const state = await this.get(id); const analyses = state.analyses.map((analysis) => { const staleReasons = [...(analysis.sourceHash !== sourceHash ? ["source" as const] : []), ...(analysis.manifestHash !== manifestHash ? ["manifest" as const] : []), ...(analysis.promptVersion !== promptVersion ? ["prompt" as const] : [])]; return referenceAnalysisSchema.parse({ ...analysis, stale: staleReasons.length > 0, staleReasons }); }); const next = referenceStateSchema.parse({ ...state, analyses, updatedAt: now() }); await atomicWrite(this.statePath(id), stringify(next, { lineWidth: 0 })); return next; }
  async writeAnalysisFile(id: string, analysisId: string, relative: string, content: string) { if (!/^(?:batches|segments|chapters|focus)\/[a-zA-Z0-9-]+\.(?:ya?ml|md)$|^(?:index\.yaml|report\.md)$/.test(relative)) throw new AppError("REFERENCE_PATH_INVALID", "分析文件路径无效。", 400, false); const target = path.join(this.analysisDir(id, analysisId), relative); await atomicWrite(target, content); return target; }
  async readAnalysisFile(id: string, analysisId: string, relative: string, maxChars = 80_000) { const root = this.analysisDir(id, analysisId); const target = path.resolve(root, relative); if (!target.startsWith(`${root}${path.sep}`) || !/\.(?:md|ya?ml)$/.test(target)) throw new AppError("REFERENCE_PATH_INVALID", "分析文件路径无效。", 400, false); const content = await readFile(target, "utf8").catch(() => { throw new AppError("REFERENCE_ANALYSIS_NOT_FOUND", "没有找到这份拆书结果。", 404, false); }); return content.slice(0, maxChars); }
  async listAnalysisFiles(id: string, analysisId: string, directory: "batches" | "segments" | "chapters" | "focus") { const root = path.join(this.analysisDir(id, analysisId), directory); return (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((item) => item.isFile()).map((item) => `${directory}/${item.name}`).sort(); }
}
