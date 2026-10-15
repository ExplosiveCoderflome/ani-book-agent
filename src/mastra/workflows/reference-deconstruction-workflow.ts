import { readFile } from "node:fs/promises";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { stringify, parse } from "yaml";
import { z } from "zod";
import {
  batchAnalysisSchema,
  chapterAnalysisSchema,
  chapterRangeSchema,
  deconstructionFocusSchema,
  deconstructionModeSchema,
  evidenceSchema,
  buildReferenceStructureRadar,
  REFERENCE_ANALYSIS_SECTIONS,
  referenceAnalysisPresetSchema,
  referenceAnalysisPresetSections,
  referenceAnalysisSchema,
  referenceAnalysisSectionKeySchema,
  referenceSectionSchema,
  referenceDimensionObservationSchema,
  segmentAnalysisSchema,
  type BatchAnalysis,
  type ChapterAnalysis,
  type ReferenceAnalysis,
  type SegmentAnalysis,
} from "../../domain";
import type { CreativeAgentPort, ModelSettingsPort, ReferenceEstimatorPort, ReferenceLibraryStore } from "../../application/ports";
import { generateWithGuard } from "../generation-guard";
import {
  requireStructuredOutput,
  structuredOutputOptions,
} from "../structured-output";
import {
  batchDescriptorSchema,
  bindSegmentIdentity,
  dimensionsForSection,
  groupReferenceSegments,
  makeReferenceBatches,
  mergeChapters,
  modelEvidenceSchema,
  modelSegmentSchema,
  rangeSchema,
  validateEvidence,
  validateSegmentOutput,
} from "./reference-deconstruction-support";
export { bindSegmentIdentity, groupReferenceSegments, makeReferenceBatches, validateEvidence } from "./reference-deconstruction-support";

export const DECONSTRUCTION_PROMPT_VERSION = "5";
type WorkflowDependencies = { references: ReferenceLibraryStore; models: ModelSettingsPort; deconstructionAgent: CreativeAgentPort; estimator: ReferenceEstimatorPort };
let workflowDependencies: WorkflowDependencies | undefined;
const dependency = () => { if (!workflowDependencies) throw new Error("拆书工作流尚未完成组合根绑定"); return workflowDependencies; };
const repository = new Proxy({} as ReferenceLibraryStore, { get: (_target, property) => (...args: unknown[]) => (dependency().references as any)[property](...args) });
const modelSettings = new Proxy({} as ModelSettingsPort, { get: (_target, property) => (...args: unknown[]) => (dependency().models as any)[property](...args) });
const deconstructionAgent = new Proxy({} as CreativeAgentPort, { get: (_target, property) => (...args: unknown[]) => (dependency().deconstructionAgent as any)[property](...args) });
const estimateDeconstruction: ReferenceEstimatorPort["estimate"] = (...args) => dependency().estimator.estimate(...args);
const referenceChaptersInRange: ReferenceEstimatorPort["chapters"] = (...args) => dependency().estimator.chapters(...args);
const providerOptions = {
  deepseek: { thinking: { type: "disabled" as const } },
};
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
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
  preset: referenceAnalysisPresetSchema,
  focuses: z.array(deconstructionFocusSchema),
  chapterRange: chapterRangeSchema.optional(),
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

const modelSceneSchema = z.object({
  goal: z.string().default("本片段未明确场景目标"),
  resistance: z.string().default("本片段未明确场景阻力"),
  turn: z.string().default("本片段未明确场景转折"),
  outcome: z.string().default("本片段未明确场景结果"),
});
const modelThreadSchema = z.object({
  text: z.string().default("本片段未明确伏笔内容"),
  action: z.enum(["introduced", "advanced", "resolved"]).default("advanced"),
});
const modelCharacterChangeSchema = z.object({
  name: z.string().default("未明确人物"),
  before: z.string().optional(),
  after: z.string().default("本片段未明确交代变化后的状态"),
  cause: z.string().default("本片段未明确交代变化原因"),
});
const modelChapterSchema = chapterAnalysisSchema.omit({ evidence: true, characterChanges: true, endingHook: true, summary: true, scenes: true, causalEvents: true, worldRules: true, threads: true, rewards: true }).extend({
  summary: z.string().default("本片段未提供摘要"),
  scenes: z.array(modelSceneSchema).default([]),
  characterChanges: z.array(modelCharacterChangeSchema).default([]),
  causalEvents: z.array(z.string()).default([]),
  worldRules: z.array(z.string()).default([]),
  threads: z.array(modelThreadSchema).default([]),
  rewards: z.array(z.string()).default([]),
  endingHook: z.string().default("本章自然收束，无明确的章末钩子"),
  evidence: z.array(modelEvidenceSchema).max(8).default([]),
});
export const modelBatchSchema = z.object({
  chapters: z.array(modelChapterSchema).min(1),
});
const focusModelSchema = z.object({
  summary: z.string(),
  mechanisms: z.array(z.string()).max(40),
  evidence: z.array(modelEvidenceSchema).max(20),
});
const modelInsightSchema = z.object({ id: z.string().min(1).max(80), title: z.string().min(1).max(160), mechanism: z.string().min(1), fitFor: z.array(z.string()).min(1).max(6), doNotCopy: z.array(z.string()).min(1).max(6), adaptationHint: z.string().min(1), evidence: z.array(modelEvidenceSchema).max(4).default([]) });
const modelCandidateSchema = z.object({ name: z.string().min(1), role: z.string().min(1), importance: z.enum(["main", "major", "supporting"]), summary: z.string().min(1), chapterIds: z.array(z.string()).max(60).default([]) });
const modelDimensionObservationSchema = referenceDimensionObservationSchema.omit({ evidence: true }).extend({ evidence: z.array(modelEvidenceSchema).min(1).max(4) });
const modelSectionSchema = z.object({ summary: z.string().min(1), content: z.string().min(1), structuredData: z.record(z.string(), z.unknown()).default({}), insights: z.array(modelInsightSchema).max(12).default([]), dimensions: z.array(modelDimensionObservationSchema).max(30).default([]), characterCandidates: z.array(modelCandidateSchema).max(30).default([]), evidence: z.array(modelEvidenceSchema).max(20).default([]) });


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

async function assertRunning(referenceId: string, jobId: string, abortSignal: AbortSignal) {
  abortSignal.throwIfAborted();
  await repository.assertActiveJob(referenceId, jobId);
  abortSignal.throwIfAborted();
}


const prepareBatches = createStep({
  id: "prepare-reference-batches",
  inputSchema: referenceWorkflowInputSchema,
  outputSchema: z.array(batchDescriptorSchema),
  suspendSchema: budgetSuspendSchema,
  resumeSchema: budgetResumeSchema,
  execute: async ({ inputData, suspend, runId, abortSignal }) => {
    if (inputData.jobId !== runId) throw new Error("拆书任务标识与运行不一致");
    await assertRunning(inputData.referenceId, runId, abortSignal);
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
      inputData.chapterRange,
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
      referenceChaptersInRange(manifest, inputData.chapterRange),
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
  execute: async ({ inputData, runId, abortSignal }) => {
    await assertRunning(inputData.referenceId, runId, abortSignal);
    const cached = await repository
      .readAnalysisFile(
        inputData.referenceId,
        inputData.analysisId,
        `batches/${inputData.batchId}.yaml`,
        500_000,
      )
      .then((value) => batchAnalysisSchema.safeParse(parse(value)))
      .catch(() => undefined);
    const sameRanges = (ranges: z.infer<typeof rangeSchema>[]) => JSON.stringify(ranges) === JSON.stringify(inputData.ranges);
    if (
      cached?.success &&
      cached.data.sourceHash === inputData.sourceHash &&
      cached.data.manifestHash === inputData.manifestHash &&
      cached.data.promptVersion === DECONSTRUCTION_PROMPT_VERSION &&
      sameRanges(cached.data.ranges)
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
      if (!reusable?.success || !sameRanges(reusable.data.ranges)) continue;
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
        runId,
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
      undefined,
      { abortSignal },
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
      runId,
    );
    return value;
  },
});


const prepareSegments = createStep({
  id: "prepare-reference-segments",
  inputSchema: z.array(batchAnalysisSchema),
  outputSchema: z.array(segmentDescriptorSchema),
  execute: async ({ inputData, runId, abortSignal }) => {
    if (!inputData.length) throw new Error("没有完成任何章节拆解");
    const first = inputData[0]!;
    await assertRunning(first.referenceId, runId, abortSignal);
    const chapters = mergeChapters(inputData.flatMap((item) => item.chapters));
    await Promise.all(
      chapters.map((chapter) =>
        repository.writeAnalysisFile(
          first.referenceId,
          first.analysisId,
          `chapters/${chapter.chapterId}.yaml`,
          stringify(chapter, { lineWidth: 0 }),
          runId,
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
  execute: async ({ inputData, runId, abortSignal }) => {
    await assertRunning(inputData.referenceId, runId, abortSignal);
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
          ...structuredOutputOptions(modelSegmentSchema),
          providerOptions,
          modelSettings: settings,
        }),
      undefined,
      { abortSignal },
    );
    const generatedSegment = requireStructuredOutput(
      modelSegmentSchema,
      result.object,
      "阶段拆解",
    );
    const [manifest, source] = await Promise.all([repository.manifest(inputData.referenceId), repository.source(inputData.referenceId)]);
    const ranges = manifest.chapters.filter((chapter) => inputData.chapterIds.includes(chapter.id)).map((chapter) => ({ chapterId: chapter.id, title: chapter.title, start: chapter.start, end: chapter.end }));
    const segment = bindSegmentIdentity(validateSegmentOutput(generatedSegment, ranges, source), inputData);
    await repository.writeAnalysisFile(
      inputData.referenceId,
      inputData.analysisId,
      `segments/${inputData.segmentId}.yaml`,
      stringify(segment, { lineWidth: 0 }),
      runId,
    );
    return {
      segment,
      usage: usage(result, request, segment),
      carryUsage: inputData.carryUsage,
    };
  },
});

const prepareMacros = createStep({
  id: "prepare-reference-macros",
  inputSchema: z.array(segmentResultSchema),
  outputSchema: z.array(macroDescriptorSchema),
  execute: async ({ inputData, getInitData, runId, abortSignal }) => {
    const init = referenceWorkflowInputSchema.parse(getInitData());
    await assertRunning(init.referenceId, runId, abortSignal);
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
  execute: async ({ inputData, runId, abortSignal }) => {
    await assertRunning(inputData.referenceId, runId, abortSignal);
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
          ...structuredOutputOptions(modelSegmentSchema),
          providerOptions,
          modelSettings: settings,
        }),
      undefined,
      { abortSignal },
    );
    const segment = requireStructuredOutput(
      modelSegmentSchema,
      generated.object,
      "宏观结构拆解",
    );
    const chapterIds = [...new Set(segments.flatMap((text) => segmentAnalysisSchema.parse(parse(text)).chapterIds))];
    const [manifest, source] = await Promise.all([repository.manifest(inputData.referenceId), repository.source(inputData.referenceId)]);
    const ranges = manifest.chapters.filter((chapter) => chapterIds.includes(chapter.id)).map((chapter) => ({ chapterId: chapter.id, title: chapter.title, start: chapter.start, end: chapter.end }));
    const value = segmentAnalysisSchema.parse({
      ...validateSegmentOutput(segment, ranges, source),
      id: inputData.macroId,
      chapterIds,
    });
    await repository.writeAnalysisFile(
      inputData.referenceId,
      inputData.analysisId,
      `segments/${inputData.macroId}.yaml`,
      stringify(value, { lineWidth: 0 }),
      runId,
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
  execute: async ({ inputData, getInitData, resumeData, suspend, runId, abortSignal }) => {
    const init = referenceWorkflowInputSchema.parse(getInitData());
    await assertRunning(init.referenceId, runId, abortSignal);
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
    }, runId);
    const latest = (await repository.get(init.referenceId)).analyses.find(
      (item) => item.id === init.analysisId,
    )!;
    const manifest = await repository.manifest(init.referenceId);
    const scopedChapters = referenceChaptersInRange(manifest, init.chapterRange);
    const scopedChars = scopedChapters.reduce((sum, chapter) => sum + chapter.end - chapter.start, 0);
    const expected =
      init.mode === "deep"
        ? Math.ceil(scopedChars * 1.3 * init.focuses.length)
        : 25_000;
    if (used.inputTokens + used.outputTokens + expected > latest.tokenBudget)
      return suspend({
        reason: "budget",
        required: used.inputTokens + used.outputTokens + expected,
        used: used.inputTokens + used.outputTokens,
        budget: latest.tokenBudget,
      });
    if (init.mode !== "deep") return [];
    const source = await repository.source(init.referenceId);
    const batches = makeReferenceBatches(
      init.referenceId,
      init.analysisId,
      init.sourceHash,
      init.manifestHash,
      scopedChapters,
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
  execute: async ({ inputData, runId, abortSignal }) => {
    await assertRunning(inputData.referenceId, runId, abortSignal);
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
      undefined,
      { abortSignal },
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
      runId,
    );
    return value;
  },
});

const finalize = createStep({
  id: "finalize-reference-analysis",
  inputSchema: z.array(focusResultSchema),
  outputSchema: workflowOutputSchema,
  suspendSchema: budgetSuspendSchema,
  resumeSchema: budgetResumeSchema,
  retries: 1,
  execute: async ({ inputData, getInitData, resumeData, suspend, runId, abortSignal }) => {
    const init = referenceWorkflowInputSchema.parse(getInitData());
    await assertRunning(init.referenceId, runId, abortSignal);
    const state = await repository.get(init.referenceId);
    const current = state.analyses.find((item) => item.id === init.analysisId)!;
    if (resumeData?.action === "cancel") {
      await repository.finishJob(init.referenceId, runId, init.analysisId, { status: "canceled" });
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
    const finalReserve = current.sectionKeys.length * 12_000;
    if (baseUsed + finalReserve > current.tokenBudget)
      return suspend({
        reason: "budget",
        required: baseUsed + finalReserve,
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
    const manifest = await repository.manifest(init.referenceId);
    const ranges = referenceChaptersInRange(manifest, init.chapterRange).map((item) => ({ chapterId: item.id, title: item.title, start: item.start, end: item.end }));
    const source = await repository.source(init.referenceId);
    const context = `参考书：${state.title}\n分析范围：${init.chapterRange ? `第 ${init.chapterRange.fromChapter}–${init.chapterRange.toChapter} 章` : "全书"}\n\n阶段事实：\n${segments.join("\n\n")}${inputData.length ? `\n\n专项扫描：\n${JSON.stringify(inputData)}` : ""}`;
    const makeSection = async (key: z.infer<typeof referenceAnalysisSectionKeySchema>, overview?: unknown) => {
      const dimensions = dimensionsForSection(key);
      const request = `${await prompt("section")}\n\n当前小节：${key}${dimensions.length ? `\n\n本小节可观察维度（只返回有明确证据的维度；未观察到的维度不要补零）：\n${JSON.stringify(dimensions)}` : "\n\n当前小节不生成维度观察。"}\n${context}${overview ? `\n\n拆书总览：\n${JSON.stringify(overview)}` : ""}`;
      const generated = await generateWithGuard(`生成拆书小节 ${key}`, (signal) => deconstructionAgent.generate(request, { abortSignal: signal, ...structuredOutputOptions(modelSectionSchema), providerOptions, modelSettings: settings }), undefined, { abortSignal });
      const draft = requireStructuredOutput(modelSectionSchema, generated.object, `拆书小节 ${key}`);
      const evidence = validateEvidence(draft.evidence, ranges, source);
      const insights = draft.insights.map((item) => ({ ...item, evidence: validateEvidence(item.evidence, ranges, source) }));
      const title = REFERENCE_ANALYSIS_SECTIONS.find((item) => item.key === key)?.title ?? key;
      const observations = draft.dimensions.flatMap((item) => {
        const dimensionEvidence = validateEvidence(item.evidence, ranges, source);
        return dimensionEvidence.length ? [referenceDimensionObservationSchema.parse({ ...item, evidence: dimensionEvidence })] : [];
      });
      return { section: referenceSectionSchema.parse({ version: 1, key, title, summary: draft.summary, content: draft.content, structuredData: draft.structuredData, evidence, insights, characterCandidates: key === "character_system" ? draft.characterCandidates : [], createdAt: new Date().toISOString() }), observations, usage: usage(generated, request, draft) };
    };
    const overviewResult = await makeSection("overview");
    const remaining = current.sectionKeys.filter((key) => key !== "overview");
    const generatedSections = await Promise.all(remaining.map((key) => makeSection(key, overviewResult.section.structuredData)));
    const rawSections = [overviewResult.section, ...generatedSections.map((item) => item.section)];
    const observations = [overviewResult, ...generatedSections].flatMap((item) => item.observations);
    const insightConfidence = new Map(observations.filter((item) => item.insightId).map((item) => [item.insightId!, item.confidence]));
    const recommendedInsightIds = [...new Map(rawSections.flatMap((section) => section.insights).map((insight) => [insight.id, insight])).values()]
      .sort((left, right) => (insightConfidence.get(right.id) ?? 0) - (insightConfidence.get(left.id) ?? 0))
      .slice(0, 3).map((item) => item.id);
    const allSections = rawSections.map((section) => referenceSectionSchema.parse({ ...section, insights: section.insights.filter((insight) => recommendedInsightIds.includes(insight.id)) }));
    const radar = buildReferenceStructureRadar(observations, recommendedInsightIds);
    abortSignal.throwIfAborted();
    await Promise.all(allSections.map((section) => repository.writeAnalysisFile(init.referenceId, init.analysisId, `sections/${section.key}.yaml`, stringify(section, { lineWidth: 0 }), runId)));
    await repository.writeAnalysisFile(init.referenceId, init.analysisId, "radar.yaml", stringify(radar, { lineWidth: 0 }), runId);
    const finalUsage = addUsage([focusUsage, overviewResult.usage, ...generatedSections.map((item) => item.usage)]);
    const inputTokens = current.inputTokens + finalUsage.inputTokens;
    const outputTokens = current.outputTokens + finalUsage.outputTokens;
    const reportPath = "index.yaml";
    await repository.writeAnalysisFile(
      init.referenceId,
      init.analysisId,
      "index.yaml",
      stringify(
        {
          version: 2,
          referenceId: init.referenceId,
          analysisId: init.analysisId,
          chapterCount: referenceChaptersInRange(await repository.manifest(init.referenceId), init.chapterRange).length,
          chapterRange: init.chapterRange,
          segmentCount: segmentFiles.length,
          preset: current.preset,
          sectionKeys: current.sectionKeys,
          inputTokens,
          outputTokens,
          usageEstimated: current.usageEstimated || finalUsage.estimated,
          radarPath: "radar.yaml",
        },
        { lineWidth: 0 },
      ),
      runId,
    );
    const completed = await repository.finishJob(init.referenceId, runId, init.analysisId, {
      status: "completed",
      inputTokens,
      outputTokens,
      usageEstimated: current.usageEstimated || finalUsage.estimated,
      reportPath,
      radarPath: "radar.yaml",
    });
    if (!completed) throw new Error("拆书任务已经停止，不能提交完成状态");
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

const referenceDeconstructionWorkflow = createWorkflow({
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

export function createReferenceDeconstructionWorkflow(deps: WorkflowDependencies) {
  if (workflowDependencies && workflowDependencies !== deps) throw new Error("拆书工作流已经绑定");
  workflowDependencies = deps;
  return referenceDeconstructionWorkflow;
}
