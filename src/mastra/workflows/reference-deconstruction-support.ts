import { z } from "zod";
import { estimateTokenCount } from "tokenx";
import { stringify } from "yaml";
import {
  chapterAnalysisSchema,
  REFERENCE_DIMENSIONS,
  referenceAnalysisSectionKeySchema,
  segmentAnalysisSchema,
  type ChapterAnalysis,
  type SegmentAnalysis,
} from "../../domain";

export const rangeSchema = z.object({
  chapterId: z.string(),
  title: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

export const batchDescriptorSchema = z.object({
  referenceId: z.string().uuid(),
  analysisId: z.string(),
  batchId: z.string(),
  sourceHash: z.string().length(64),
  manifestHash: z.string().length(64),
  ranges: z.array(rangeSchema).min(1),
});

export const modelEvidenceSchema = z.object({
  chapterId: z.string().default("__unmatched__"),
  excerpt: z.string().min(1).max(240).default("未提供可定位证据"),
});

// Source offsets are verified by code, never authored by the model.
export const modelSegmentSchema = segmentAnalysisSchema.extend({ evidence: z.array(modelEvidenceSchema).max(12) });
export function validateSegmentOutput(value: unknown, ranges: z.infer<typeof rangeSchema>[], source: string) {
  const segment = modelSegmentSchema.parse(value);
  return segmentAnalysisSchema.parse({ ...segment, evidence: validateEvidence(segment.evidence, ranges, source) });
}

export function dimensionsForSection(key: z.infer<typeof referenceAnalysisSectionKeySchema>) {
  const ranges: Record<z.infer<typeof referenceAnalysisSectionKeySchema>, Array<[number, number]>> = {
    overview: [],
    plot_structure: [[23, 37]],
    timeline: [[23, 37]],
    character_system: [[1, 12]],
    worldbuilding: [[13, 22], [38, 58]],
    themes: [[59, 66]],
    style_technique: [[31, 37], [67, 70]],
    market_highlights: [[59, 70]],
  };
  return REFERENCE_DIMENSIONS.filter(([id]) => ranges[key].some(([from, to]) => Number(id) >= from && Number(id) <= to));
}

export function makeReferenceBatches(
  referenceId: string,
  analysisId: string,
  sourceHash: string,
  manifestHash: string,
  chapters: Array<{ id: string; title: string; start: number; end: number }>,
  maxChars = 18_000,
  source?: string,
) {
  const ranges = chapters.flatMap((chapter) => {
    const items = [];
    for (let start = chapter.start; start < chapter.end; ) {
      let end = Math.min(chapter.end, start + maxChars);
      if (source && end < chapter.end) {
        const minimum = start + Math.floor(maxChars * 0.6);
        const paragraph = source.lastIndexOf("\n\n", end);
        const line = source.lastIndexOf("\n", end);
        const boundary = paragraph >= minimum ? paragraph + 2 : line >= minimum ? line + 1 : end;
        end = Math.min(chapter.end, boundary);
      }
      items.push({ chapterId: chapter.id, title: chapter.title, start, end });
      start = end;
    }
    return items;
  });
  const batches: z.infer<typeof batchDescriptorSchema>[] = [];
  let current: typeof ranges = [];
  let size = 0;
  for (const range of ranges) {
    const length = range.end - range.start;
    if (current.length && size + length > maxChars) {
      batches.push(batchDescriptorSchema.parse({ referenceId, analysisId, batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`, sourceHash, manifestHash, ranges: current }));
      current = [];
      size = 0;
    }
    current.push(range);
    size += length;
  }
  if (current.length) batches.push(batchDescriptorSchema.parse({ referenceId, analysisId, batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`, sourceHash, manifestHash, ranges: current }));
  return batches;
}

export function validateEvidence(raw: z.infer<typeof modelEvidenceSchema>[], ranges: z.infer<typeof rangeSchema>[], source: string) {
  return raw.flatMap((item) => {
    for (const range of ranges) {
      if (range.chapterId !== item.chapterId) continue;
      const local = source.slice(range.start, range.end).indexOf(item.excerpt);
      if (local >= 0) return [{ chapterId: item.chapterId, excerpt: item.excerpt, start: range.start + local, end: range.start + local + item.excerpt.length }];
    }
    return [];
  });
}

export function mergeChapters(values: ChapterAnalysis[]) {
  const result = new Map<string, ChapterAnalysis>();
  for (const item of values) {
    const prior = result.get(item.chapterId);
    if (!prior) result.set(item.chapterId, item);
    else result.set(item.chapterId, chapterAnalysisSchema.parse({
      ...prior,
      summary: `${prior.summary}\n${item.summary}`,
      scenes: [...prior.scenes, ...item.scenes],
      characterChanges: [...prior.characterChanges, ...item.characterChanges],
      causalEvents: [...prior.causalEvents, ...item.causalEvents],
      worldRules: [...prior.worldRules, ...item.worldRules],
      threads: [...prior.threads, ...item.threads],
      rewards: [...prior.rewards, ...item.rewards],
      endingHook: item.endingHook || prior.endingHook,
      evidence: [...prior.evidence, ...item.evidence].slice(0, 8),
    }));
  }
  return [...result.values()];
}

// Leave 8k of the Agent's 32k budget for instructions, schemas and message overhead.
export const REFERENCE_SEGMENT_INPUT_TOKENS = 24_000;
export function groupReferenceSegments(chapters: ChapterAnalysis[], volumes: Map<string, string | undefined>) {
  const groups: ChapterAnalysis[][] = [];
  let group: ChapterAnalysis[] = [];
  let text = "";
  for (const chapter of chapters) {
    const chapterText = stringify(chapter, { lineWidth: 0 });
    if (estimateTokenCount(chapterText) > REFERENCE_SEGMENT_INPUT_TOKENS) throw new Error(`《${chapter.title ?? chapter.chapterId}》的章节分析超过阶段聚合输入预算，已完成的章节结果仍会保留，请缩小分析范围后重试。`);
    const candidate = text ? `${text}\n\n${chapterText}` : chapterText;
    if (group.length && (group.length === 25 || volumes.get(chapter.chapterId) !== volumes.get(group[0]!.chapterId) || estimateTokenCount(candidate) > REFERENCE_SEGMENT_INPUT_TOKENS)) {
      groups.push(group);
      group = [];
      text = "";
    }
    group.push(chapter);
    text = text ? `${text}\n\n${chapterText}` : chapterText;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function bindSegmentIdentity(segment: SegmentAnalysis, descriptor: { segmentId: string; title: string; chapterIds: string[] }) {
  return segmentAnalysisSchema.parse({ ...segment, id: descriptor.segmentId, title: descriptor.title, chapterIds: descriptor.chapterIds });
}
