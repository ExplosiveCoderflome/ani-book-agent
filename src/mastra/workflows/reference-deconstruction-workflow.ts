import { readFile } from "node:fs/promises";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { stringify, parse } from "yaml";
import { z } from "zod";
import {
  batchAnalysisSchema,
  chapterAnalysisSchema,
  deconstructionFocusSchema,
  deconstructionModeSchema,
  evidenceSchema,
  referenceAnalysisSchema,
  segmentAnalysisSchema,
  type BatchAnalysis,
  type ChapterAnalysis,
  type ReferenceAnalysis,
  type SegmentAnalysis,
} from "../../domain";
import { modelSettings } from "../../infrastructure/model-settings";
import {
  estimateDeconstruction,
  ReferenceRepository,
} from "../../infrastructure/reference-repository";
import { deconstructionAgent } from "../agents/deconstruction-agent";
import { generateWithGuard } from "../generation-guard";
import {
  requireStructuredOutput,
  structuredOutputOptions,
} from "../structured-output";

export const DECONSTRUCTION_PROMPT_VERSION = "1";
const repository = new ReferenceRepository();
const providerOptions = {
  deepseek: { thinking: { type: "disabled" as const } },
};
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
const rangeSchema = z.object({
  chapterId: z.string(),
  title: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
const batchDescriptorSchema = z.object({
  referenceId: z.string().uuid(),
  analysisId: z.string(),
  batchId: z.string(),
  sourceHash: z.string().length(64),
  manifestHash: z.string().length(64),
  ranges: z.array(rangeSchema).min(1),
});
const segmentDescriptorSchema = z.object({
  referenceId: z.string().uuid(),
  analysisId: z.string(),
  segmentId: z.string(),
  title: z.string(),
  chapterIds: z.array(z.string()).min(1),
  carryUsage: usageSchema,
});
const segmentResultSchema = z.object({
  segment: segmentAnalysisSchema,
  usage: usageSchema,
  carryUsage: usageSchema,
});
const macroDescriptorSchema = z.object({
  referenceId: z.string().uuid(),
  analysisId: z.string(),
  macroId: z.string(),
  segmentIds: z.array(z.string()).min(1),
  carryUsage: usageSchema,
});
const focusDescriptorSchema = batchDescriptorSchema.extend({
  focus: deconstructionFocusSchema,
});
const focusResultSchema = z.object({
  focus: deconstructionFocusSchema,
  batchId: z.string(),
  summary: z.string(),
  mechanisms: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  usage: usageSchema,
});

export const referenceWorkflowInputSchema = z.object({
  referenceId: z.string().uuid(),
  jobId: z.string(),
  analysisId: z.string(),
  sourceHash: z.string().length(64),
  manifestHash: z.string().length(64),
  mode: deconstructionModeSchema,
  focuses: z.array(deconstructionFocusSchema),
  tokenBudget: z.number().int().min(100_000).max(50_000_000),
  promptVersion: z.literal(DECONSTRUCTION_PROMPT_VERSION),
});
const workflowOutputSchema = z.object({
  status: z.enum(["completed", "canceled"]),
  referenceId: z.string().uuid(),
  jobId: z.string(),
  analysisId: z.string(),
  reportPath: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const budgetSuspendSchema = z.object({
  reason: z.literal("budget"),
  required: z.number().int().positive(),
  used: z.number().int().nonnegative(),
  budget: z.number().int().positive(),
});
const budgetResumeSchema = z.object({ action: z.enum(["continue", "cancel"]) });

const modelEvidenceSchema = z.object({
  chapterId: z.string(),
  excerpt: z.string().min(1).max(240),
});
const modelChapterSchema = chapterAnalysisSchema
  .omit({ evidence: true })
  .extend({ evidence: z.array(modelEvidenceSchema).max(8).default([]) });
const modelBatchSchema = z.object({
  chapters: z.array(modelChapterSchema).min(1),
});
const focusModelSchema = z.object({
  summary: z.string(),
  mechanisms: z.array(z.string()).max(40),
  evidence: z.array(modelEvidenceSchema).max(20),
});
const bookReportSchema = z.object({
  mechanism: z.string(),
  marketPromise: z.string(),
  protagonistEngine: z.string(),
  structureAndEscalation: z.string(),
  charactersAndRelationships: z.string(),
  scenesAndPacing: z.string(),
  promisesAndPayoffs: z.string(),
  chapterHooks: z.string(),
  risks: z.string(),
  transferableMethods: z.array(z.string()).min(3).max(12),
  doNotCopy: z.array(z.string()).min(1).max(10),
  evidenceBoundary: z.string(),
});

async function prompt(name: string) {
  const source = await readFile(
    path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      "src",
      "mastra",
      "prompts",
      "deconstruction",
      `${name}.md`,
    ),
    "utf8",
  );
  return source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}
async function selectedSettings(outputCap: number) {
  const selected = await modelSettingsStore();
  return {
    temperature: selected.parameters.temperature,
    topP: selected.parameters.topP,
    maxOutputTokens: Math.min(
      selected.parameters.maxOutputTokens ?? outputCap,
      outputCap,
    ),
  };
}
async function modelSettingsStore() {
  return modelSettings.runtimeSelection("analysis");
}
function usage(result: any, input: string, output: unknown) {
  const inputTokens = Number(
    result?.usage?.inputTokens ?? result?.usage?.promptTokens,
  );
  const outputTokens = Number(
    result?.usage?.outputTokens ?? result?.usage?.completionTokens,
  );
  if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens))
    return usageSchema.parse({ inputTokens, outputTokens, estimated: false });
  return usageSchema.parse({
    inputTokens: Math.ceil(input.length * 1.3),
    outputTokens: Math.ceil(JSON.stringify(output).length),
    estimated: true,
  });
}
function addUsage(values: Array<z.infer<typeof usageSchema>>) {
  return usageSchema.parse({
    inputTokens: values.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: values.reduce((sum, item) => sum + item.outputTokens, 0),
    estimated: values.some((item) => item.estimated),
  });
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
        const boundary =
          paragraph >= minimum
            ? paragraph + 2
            : line >= minimum
              ? line + 1
              : end;
        end = Math.min(chapter.end, boundary);
      }
      items.push({
        chapterId: chapter.id,
        title: chapter.title,
        start,
        end,
      });
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
      batches.push(
        batchDescriptorSchema.parse({
          referenceId,
          analysisId,
          batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`,
          sourceHash,
          manifestHash,
          ranges: current,
        }),
      );
      current = [];
      size = 0;
    }
    current.push(range);
    size += length;
  }
  if (current.length)
    batches.push(
      batchDescriptorSchema.parse({
        referenceId,
        analysisId,
        batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`,
        sourceHash,
        manifestHash,
        ranges: current,
      }),
    );
  return batches;
}

export function validateEvidence(
  raw: z.infer<typeof modelEvidenceSchema>[],
  ranges: z.infer<typeof rangeSchema>[],
  source: string,
) {
  return raw.flatMap((item) => {
    for (const range of ranges) {
      if (range.chapterId !== item.chapterId) continue;
      const local = source.slice(range.start, range.end).indexOf(item.excerpt);
      if (local >= 0)
        return [
          {
            chapterId: item.chapterId,
            excerpt: item.excerpt,
            start: range.start + local,
            end: range.start + local + item.excerpt.length,
          },
        ];
    }
    return [];
  });
}

const prepareBatches = createStep({
  id: "prepare-reference-batches",
  inputSchema: referenceWorkflowInputSchema,
  outputSchema: z.array(batchDescriptorSchema),
  suspendSchema: budgetSuspendSchema,
  resumeSchema: budgetResumeSchema,
  execute: async ({ inputData, suspend }) => {
    const [state, manifest, source] = await Promise.all([
      repository.get(inputData.referenceId),
      repository.manifest(inputData.referenceId),
      repository.source(inputData.referenceId),
    ]);
    if (
      !state.manifestConfirmed ||
      state.source.sha256 !== inputData.sourceHash ||
      manifest.sha256 !== inputData.manifestHash
    )
      throw new Error("参考书来源或章节切分已经变化，请重新确认");
    const analysis = state.analyses.find(
      (item) => item.id === inputData.analysisId,
    )!;
    const estimate = estimateDeconstruction(
      manifest,
      inputData.mode,
      inputData.focuses,
    );
    const required = estimate.inputMax + estimate.outputMax;
    if (
      analysis.inputTokens + analysis.outputTokens + required >
      analysis.tokenBudget
    )
      return suspend({
        reason: "budget",
        required: analysis.inputTokens + analysis.outputTokens + required,
        used: analysis.inputTokens + analysis.outputTokens,
        budget: analysis.tokenBudget,
      });
    return makeReferenceBatches(
      inputData.referenceId,
      inputData.analysisId,
      inputData.sourceHash,
      inputData.manifestHash,
      manifest.chapters,
      18_000,
      source,
    );
  },
});

const analyzeBatch = createStep({
  id: "analyze-reference-batch",
  inputSchema: batchDescriptorSchema,
  outputSchema: batchAnalysisSchema,
  retries: 2,
  execute: async ({ inputData }) => {
    const cached = await repository
      .readAnalysisFile(
        inputData.referenceId,
        inputData.analysisId,
        `batches/${inputData.batchId}.yaml`,
        500_000,
      )
      .then((value) => batchAnalysisSchema.safeParse(parse(value)))
      .catch(() => undefined);
    if (
      cached?.success &&
      cached.data.sourceHash === inputData.sourceHash &&
      cached.data.manifestHash === inputData.manifestHash &&
      cached.data.promptVersion === DECONSTRUCTION_PROMPT_VERSION
    )
      return cached.data;
    const state = await repository.get(inputData.referenceId);
    for (const prior of [...state.analyses].reverse()) {
      if (
        prior.id === inputData.analysisId ||
        prior.sourceHash !== inputData.sourceHash ||
        prior.manifestHash !== inputData.manifestHash ||
        prior.promptVersion !== DECONSTRUCTION_PROMPT_VERSION
      )
        continue;
      const reusable = await repository
        .readAnalysisFile(
          inputData.referenceId,
          prior.id,
          `batches/${inputData.batchId}.yaml`,
          500_000,
        )
        .then((value) => batchAnalysisSchema.safeParse(parse(value)))
        .catch(() => undefined);
      if (!reusable?.success) continue;
      const reused = batchAnalysisSchema.parse({
        ...reusable.data,
        analysisId: inputData.analysisId,
        usage: { inputTokens: 0, outputTokens: 0, estimated: false },
      });
      await repository.writeAnalysisFile(
        inputData.referenceId,
        inputData.analysisId,
        `batches/${inputData.batchId}.yaml`,
        stringify(reused, { lineWidth: 0 }),
      );
      return reused;
    }
    const source = await repository.source(inputData.referenceId);
    const sections = inputData.ranges
      .map(
        (range) =>
          `## ${range.chapterId} · ${range.title} · OFFSET ${range.start}-${range.end}\n${source.slice(range.start, range.end)}`,
      )
      .join("\n\n");
    const request = `${await prompt("chapter")}\n\n${sections}`;
    const settings = await selectedSettings(8_000);
    const result = await generateWithGuard(
      `拆解 ${inputData.batchId}`,
      (abortSignal) =>
        deconstructionAgent.generate(request, {
          abortSignal,
          ...structuredOutputOptions(modelBatchSchema),
          providerOptions,
          modelSettings: settings,
        }),
    );
    const parsed = requireStructuredOutput(
      modelBatchSchema,
      result.object,
      "逐章拆解",
    );
    const chapters = parsed.chapters.map((chapter) =>
      chapterAnalysisSchema.parse({
        ...chapter,
        evidence: validateEvidence(chapter.evidence, inputData.ranges, source),
      }),
    );
    const value = batchAnalysisSchema.parse({
      ...inputData,
      promptVersion: DECONSTRUCTION_PROMPT_VERSION,
      chapters,
      usage: usage(result, request, parsed),
    });
    await repository.writeAnalysisFile(
      inputData.referenceId,
      inputData.analysisId,
      `batches/${inputData.batchId}.yaml`,
      stringify(value, { lineWidth: 0 }),
    );
    return value;
  },
});

function mergeChapters(values: ChapterAnalysis[]) {
  const result = new Map<string, ChapterAnalysis>();
  for (const item of values) {
    const prior = result.get(item.chapterId);
    if (!prior) result.set(item.chapterId, item);
    else
      result.set(
        item.chapterId,
        chapterAnalysisSchema.parse({
          ...prior,
          summary: `${prior.summary}\n${item.summary}`,
          scenes: [...prior.scenes, ...item.scenes],
          characterChanges: [
            ...prior.characterChanges,
            ...item.characterChanges,
          ],
          causalEvents: [...prior.causalEvents, ...item.causalEvents],
          worldRules: [...prior.worldRules, ...item.worldRules],
          threads: [...prior.threads, ...item.threads],
          rewards: [...prior.rewards, ...item.rewards],
          endingHook: item.endingHook || prior.endingHook,
          evidence: [...prior.evidence, ...item.evidence].slice(0, 8),
        }),
      );
  }
  return [...result.values()];
}

export function groupReferenceSegments(
  chapters: ChapterAnalysis[],
  volumes: Map<string, string | undefined>,
) {
  const groups: ChapterAnalysis[][] = [];
  for (let index = 0; index < chapters.length; ) {
    const volume = volumes.get(chapters[index]!.chapterId);
    let end = Math.min(chapters.length, index + 25);
    const boundary = chapters.findIndex(
      (item, candidate) =>
        candidate > index && volumes.get(item.chapterId) !== volume,
    );
    if (boundary >= 0) end = Math.min(end, boundary);
    groups.push(chapters.slice(index, end));
    index = end;
  }
  return groups;
}

const prepareSegments = createStep({
  id: "prepare-reference-segments",
  inputSchema: z.array(batchAnalysisSchema),
  outputSchema: z.array(segmentDescriptorSchema),
  execute: async ({ inputData }) => {
    if (!inputData.length) throw new Error("没有完成任何章节拆解");
    const first = inputData[0]!;
    const chapters = mergeChapters(inputData.flatMap((item) => item.chapters));
    await Promise.all(
      chapters.map((chapter) =>
        repository.writeAnalysisFile(
          first.referenceId,
          first.analysisId,
          `chapters/${chapter.chapterId}.yaml`,
          stringify(chapter, { lineWidth: 0 }),
        ),
      ),
    );
    const totalUsage = addUsage(inputData.map((item) => item.usage));
    const manifest = await repository.manifest(first.referenceId);
    const volumes = new Map(
      manifest.chapters.map((item) => [item.id, item.volume]),
    );
    const descriptors = [];
    for (const group of groupReferenceSegments(chapters, volumes)) {
      descriptors.push(
        segmentDescriptorSchema.parse({
          referenceId: first.referenceId,
          analysisId: first.analysisId,
          segmentId: `segment-${String(descriptors.length + 1).padStart(3, "0")}`,
          title: `${group[0]!.title}—${group.at(-1)!.title}`,
          chapterIds: group.map((item) => item.chapterId),
          carryUsage: descriptors.length
            ? { inputTokens: 0, outputTokens: 0, estimated: false }
            : totalUsage,
        }),
      );
    }
    return descriptors;
  },
});

const analyzeSegment = createStep({
  id: "analyze-reference-segment",
  inputSchema: segmentDescriptorSchema,
  outputSchema: segmentResultSchema,
  retries: 2,
  execute: async ({ inputData }) => {
    const chapters = await Promise.all(
      inputData.chapterIds.map((id) =>
        repository.readAnalysisFile(
          inputData.referenceId,
          inputData.analysisId,
          `chapters/${id}.yaml`,
          100_000,
        ),
      ),
    );
    const request = `${await prompt("segment")}\n\n${chapters.join("\n\n")}`;
    const settings = await selectedSettings(6_000);
    const result = await generateWithGuard(
      `聚合 ${inputData.segmentId}`,
      (abortSignal) =>
        deconstructionAgent.generate(request, {
          abortSignal,
          ...structuredOutputOptions(segmentAnalysisSchema),
          providerOptions,
          modelSettings: settings,
        }),
    );
    const generatedSegment = requireStructuredOutput(
      segmentAnalysisSchema,
      result.object,
      "阶段拆解",
    );
    const segment = bindSegmentIdentity(generatedSegment, inputData);
    await repository.writeAnalysisFile(
      inputData.referenceId,
      inputData.analysisId,
      `segments/${inputData.segmentId}.yaml`,
      stringify(segment, { lineWidth: 0 }),
    );
    return {
      segment,
      usage: usage(result, request, segment),
      carryUsage: inputData.carryUsage,
    };
  },
});

export function bindSegmentIdentity(
  segment: SegmentAnalysis,
  descriptor: { segmentId: string; title: string; chapterIds: string[] },
) {
  return segmentAnalysisSchema.parse({
    ...segment,
    id: descriptor.segmentId,
    title: descriptor.title,
    chapterIds: descriptor.chapterIds,
  });
}

const prepareMacros = createStep({
  id: "prepare-reference-macros",
  inputSchema: z.array(segmentResultSchema),
  outputSchema: z.array(macroDescriptorSchema),
  execute: async ({ inputData, getInitData }) => {
    const init = referenceWorkflowInputSchema.parse(getInitData());
    const totalUsage = addUsage(
      inputData.flatMap((item) => [item.usage, item.carryUsage]),
    );
    const ids = inputData.map((item) => item.segment.id);
    const result = [];
    for (let index = 0; index < ids.length; index += 4)
      result.push(
        macroDescriptorSchema.parse({
          referenceId: init.referenceId,
          analysisId: init.analysisId,
          macroId: `macro-${String(result.length + 1).padStart(3, "0")}`,
          segmentIds: ids.slice(index, index + 4),
          carryUsage: result.length
            ? { inputTokens: 0, outputTokens: 0, estimated: false }
            : totalUsage,
        }),
      );
    return result;
  },
});

const analyzeMacro = createStep({
  id: "analyze-reference-macro",
  inputSchema: macroDescriptorSchema,
  outputSchema: segmentResultSchema,
  retries: 2,
  execute: async ({ inputData }) => {
    const segments = await Promise.all(
      inputData.segmentIds.map((id) =>
        repository.readAnalysisFile(
          inputData.referenceId,
          inputData.analysisId,
          `segments/${id}.yaml`,
          100_000,
        ),
      ),
    );
    const request = `${await prompt("segment")}\n\n这是连续阶段的宏观聚合，请保留升级与因果承接：\n${segments.join("\n\n")}`;
    const settings = await selectedSettings(6_000);
    const generated = await generateWithGuard(
      `聚合 ${inputData.macroId}`,
      (abortSignal) =>
        deconstructionAgent.generate(request, {
          abortSignal,
          ...structuredOutputOptions(segmentAnalysisSchema),
          providerOptions,
          modelSettings: settings,
        }),
    );
    const segment = requireStructuredOutput(
      segmentAnalysisSchema,
      generated.object,
      "宏观结构拆解",
    );
    const value = segmentAnalysisSchema.parse({
      ...segment,
      id: inputData.macroId,
    });
    await repository.writeAnalysisFile(
      inputData.referenceId,
      inputData.analysisId,
      `segments/${inputData.macroId}.yaml`,
      stringify(value, { lineWidth: 0 }),
    );
    return {
      segment: value,
      usage: usage(generated, request, value),
      carryUsage: inputData.carryUsage,
    };
  },
});

const prepareFocus = createStep({
  id: "prepare-reference-focus",
  inputSchema: z.array(segmentResultSchema),
  outputSchema: z.array(focusDescriptorSchema),
  suspendSchema: budgetSuspendSchema,
  resumeSchema: budgetResumeSchema,
  execute: async ({ inputData, getInitData, resumeData, suspend }) => {
    const init = referenceWorkflowInputSchema.parse(getInitData());
    if (resumeData?.action === "cancel") return [];
    const used = addUsage(
      inputData.flatMap((item) => [item.usage, item.carryUsage]),
    );
    const state = await repository.get(init.referenceId);
    const current = state.analyses.find((item) => item.id === init.analysisId)!;
    await repository.updateAnalysis(init.referenceId, {
      ...current,
      inputTokens: used.inputTokens,
      outputTokens: used.outputTokens,
      usageEstimated: used.estimated,
      updatedAt: new Date().toISOString(),
    });
    const latest = (await repository.get(init.referenceId)).analyses.find(
      (item) => item.id === init.analysisId,
    )!;
    const expected =
      init.mode === "deep"
        ? Math.ceil(state.source.chars * 1.3 * init.focuses.length)
        : 25_000;
    if (used.inputTokens + used.outputTokens + expected > latest.tokenBudget)
      return suspend({
        reason: "budget",
        required: used.inputTokens + used.outputTokens + expected,
        used: used.inputTokens + used.outputTokens,
        budget: latest.tokenBudget,
      });
    if (init.mode !== "deep") return [];
    const [manifest, source] = await Promise.all([
      repository.manifest(init.referenceId),
      repository.source(init.referenceId),
    ]);
    const batches = makeReferenceBatches(
      init.referenceId,
      init.analysisId,
      init.sourceHash,
      init.manifestHash,
      manifest.chapters,
      18_000,
      source,
    );
    return init.focuses.flatMap((focus) =>
      batches.map((batch) => ({ ...batch, focus })),
    );
  },
});

const analyzeFocus = createStep({
  id: "analyze-reference-focus",
  inputSchema: focusDescriptorSchema,
  outputSchema: focusResultSchema,
  retries: 2,
  execute: async ({ inputData }) => {
    const source = await repository.source(inputData.referenceId);
    const sections = inputData.ranges
      .map(
        (range) =>
          `## ${range.chapterId} · ${range.title}\n${source.slice(range.start, range.end)}`,
      )
      .join("\n\n");
    const name =
      inputData.focus === "structure"
        ? "focus-structure"
        : inputData.focus === "characters"
          ? "focus-characters"
          : "focus-pacing-hooks";
    const request = `${await prompt(name)}\n\n${sections}`;
    const settings = await selectedSettings(4_000);
    const result = await generateWithGuard(
      `专项 ${inputData.focus} ${inputData.batchId}`,
      (abortSignal) =>
        deconstructionAgent.generate(request, {
          abortSignal,
          ...structuredOutputOptions(focusModelSchema),
          providerOptions,
          modelSettings: settings,
        }),
    );
    const parsed = requireStructuredOutput(
      focusModelSchema,
      result.object,
      "专项拆解",
    );
    const value = focusResultSchema.parse({
      focus: inputData.focus,
      batchId: inputData.batchId,
      summary: parsed.summary,
      mechanisms: parsed.mechanisms,
      evidence: validateEvidence(parsed.evidence, inputData.ranges, source),
      usage: usage(result, request, parsed),
    });
    await repository.writeAnalysisFile(
      inputData.referenceId,
      inputData.analysisId,
      `focus/${inputData.focus}-${inputData.batchId}.yaml`,
      stringify(value, { lineWidth: 0 }),
    );
    return value;
  },
});

function reportMarkdown(
  title: string,
  report: z.infer<typeof bookReportSchema>,
  focuses: z.infer<typeof focusResultSchema>[],
) {
  const focusText = focuses.length
    ? [
        "## 深度专项",
        ...[...new Set(focuses.map((item) => item.focus))].map(
          (focus) =>
            `### ${focus}\n${focuses
              .filter((item) => item.focus === focus)
              .map((item) => item.summary)
              .join("\n")}`,
        ),
      ].join("\n\n")
    : "";
  return [
    `# 《${title}》拆书报告`,
    "",
    "## 一句话机制判断",
    report.mechanism,
    "",
    "## 核心阅读承诺",
    report.marketPromise,
    "",
    "## 主角行动引擎",
    report.protagonistEngine,
    "",
    "## 结构与升级",
    report.structureAndEscalation,
    "",
    "## 人物与关系",
    report.charactersAndRelationships,
    "",
    "## 场景与节奏",
    report.scenesAndPacing,
    "",
    "## 伏笔与兑现",
    report.promisesAndPayoffs,
    "",
    "## 章节钩子",
    report.chapterHooks,
    "",
    "## 主要风险",
    report.risks,
    "",
    "## 可迁移方法",
    ...report.transferableMethods.map((item) => `- ${item}`),
    "",
    "## 不应复制",
    ...report.doNotCopy.map((item) => `- ${item}`),
    "",
    "## 证据与推断边界",
    report.evidenceBoundary,
    "",
    focusText,
    "",
  ].join("\n");
}

const finalize = createStep({
  id: "finalize-reference-analysis",
  inputSchema: z.array(focusResultSchema),
  outputSchema: workflowOutputSchema,
  suspendSchema: budgetSuspendSchema,
  resumeSchema: budgetResumeSchema,
  retries: 1,
  execute: async ({ inputData, getInitData, resumeData, suspend }) => {
    const init = referenceWorkflowInputSchema.parse(getInitData());
    const state = await repository.get(init.referenceId);
    const current = state.analyses.find((item) => item.id === init.analysisId)!;
    if (resumeData?.action === "cancel") {
      await repository.updateAnalysis(init.referenceId, {
        ...current,
        status: "canceled",
        updatedAt: new Date().toISOString(),
      });
      await repository.setActive();
      return {
        status: "canceled" as const,
        referenceId: init.referenceId,
        jobId: init.jobId,
        analysisId: init.analysisId,
        inputTokens: current.inputTokens,
        outputTokens: current.outputTokens,
      };
    }
    const focusUsage = addUsage(inputData.map((item) => item.usage));
    const baseUsed =
      current.inputTokens +
      current.outputTokens +
      focusUsage.inputTokens +
      focusUsage.outputTokens;
    if (baseUsed + 50_000 > current.tokenBudget)
      return suspend({
        reason: "budget",
        required: baseUsed + 50_000,
        used: baseUsed,
        budget: current.tokenBudget,
      });
    const analysisSegments = await repository.listAnalysisFiles(
      init.referenceId,
      init.analysisId,
      "segments",
    );
    const segmentFiles = analysisSegments.filter((file) =>
      /\/segment-/.test(file),
    );
    const macroFiles = analysisSegments.filter((file) => /\/macro-/.test(file));
    const segments = await Promise.all(
      macroFiles.map((file) =>
        repository.readAnalysisFile(
          init.referenceId,
          init.analysisId,
          file,
          100_000,
        ),
      ),
    );
    const settings = await selectedSettings(10_000);
    const request = `${await prompt("book")}\n\n参考书：${state.title}\n\n${segments.join("\n\n")}${inputData.length ? `\n\n专项结果：\n${JSON.stringify(inputData)}` : ""}`;
    const generated = await generateWithGuard("生成全书拆解", (abortSignal) =>
      deconstructionAgent.generate(request, {
        abortSignal,
        ...structuredOutputOptions(bookReportSchema),
        providerOptions,
        modelSettings: settings,
      }),
    );
    const draft = requireStructuredOutput(
      bookReportSchema,
      generated.object,
      "全书拆解",
    );
    const evidence = segments
      .flatMap((value) => segmentAnalysisSchema.parse(parse(value)).evidence)
      .slice(0, 40);
    const verifiedSource = await Promise.all(
      evidence.map((item) =>
        repository.sourceSlice(init.referenceId, item.start, item.end),
      ),
    );
    const verifyRequest = `${await prompt("verify")}\n\n阶段证据：\n${segments.join("\n\n")}\n\n按偏移复读的原文证据：\n${verifiedSource.map((item) => `OFFSET ${item.start}-${item.end}: ${item.content}`).join("\n")}\n\n待复核报告：\n${JSON.stringify(draft)}`;
    const verifiedResult = await generateWithGuard(
      "复核拆书证据",
      (abortSignal) =>
        deconstructionAgent.generate(verifyRequest, {
          abortSignal,
          ...structuredOutputOptions(bookReportSchema),
          providerOptions,
          modelSettings: settings,
        }),
    );
    const verified = requireStructuredOutput(
      bookReportSchema,
      verifiedResult.object,
      "拆书证据复核",
    );
    const finalUsage = addUsage([
      focusUsage,
      usage(generated, request, draft),
      usage(verifiedResult, verifyRequest, verified),
    ]);
    const inputTokens = current.inputTokens + finalUsage.inputTokens;
    const outputTokens = current.outputTokens + finalUsage.outputTokens;
    const reportPath = "report.md";
    await repository.writeAnalysisFile(
      init.referenceId,
      init.analysisId,
      reportPath,
      reportMarkdown(state.title, verified, inputData),
    );
    await repository.writeAnalysisFile(
      init.referenceId,
      init.analysisId,
      "index.yaml",
      stringify(
        {
          version: 1,
          referenceId: init.referenceId,
          analysisId: init.analysisId,
          chapterCount: (await repository.manifest(init.referenceId)).chapters
            .length,
          segmentCount: segmentFiles.length,
          inputTokens,
          outputTokens,
          usageEstimated: current.usageEstimated || finalUsage.estimated,
        },
        { lineWidth: 0 },
      ),
    );
    await repository.updateAnalysis(init.referenceId, {
      ...current,
      status: "completed",
      inputTokens,
      outputTokens,
      usageEstimated: current.usageEstimated || finalUsage.estimated,
      reportPath,
      updatedAt: new Date().toISOString(),
    });
    await repository.setActive();
    return {
      status: "completed" as const,
      referenceId: init.referenceId,
      jobId: init.jobId,
      analysisId: init.analysisId,
      reportPath,
      inputTokens,
      outputTokens,
    };
  },
});

export const referenceDeconstructionWorkflow = createWorkflow({
  id: "reference-deconstruction",
  description: "可恢复的全局长篇拆书 Map/Reduce 流程。",
  inputSchema: referenceWorkflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(prepareBatches)
  .foreach(analyzeBatch, { concurrency: 2 })
  .then(prepareSegments)
  .foreach(analyzeSegment, { concurrency: 2 })
  .then(prepareMacros)
  .foreach(analyzeMacro, { concurrency: 2 })
  .then(prepareFocus)
  .foreach(analyzeFocus, { concurrency: 2 })
  .then(finalize)
  .commit();
