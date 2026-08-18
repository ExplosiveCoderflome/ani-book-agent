import { z } from "zod";

export const deconstructionModeSchema = z.enum(["standard", "deep"]);
export const deconstructionFocusSchema = z.enum(["structure", "characters", "pacing_hooks"]);
export const MIN_REFERENCE_TOKEN_BUDGET = 100_000;
export const MAX_REFERENCE_TOKEN_BUDGET = 50_000_000;
export type DeconstructionMode = z.infer<typeof deconstructionModeSchema>;
export type DeconstructionFocus = z.infer<typeof deconstructionFocusSchema>;

export const chapterManifestItemSchema = z.object({
  id: z.string().regex(/^chapter-\d{4,}$/), index: z.number().int().nonnegative(), title: z.string().min(1).max(300),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), volume: z.string().max(300).optional(), kind: z.enum(["chapter", "frontmatter"]).default("chapter"),
});
export type ChapterManifestItem = z.infer<typeof chapterManifestItemSchema>;
export const chapterManifestSchema = z.object({
  version: z.literal(1), sourceHash: z.string().length(64), method: z.enum(["headings", "fixed"]), targetChars: z.number().int().positive(),
  totalChars: z.number().int().nonnegative(), chapters: z.array(chapterManifestItemSchema).min(1), generatedAt: z.string(), confirmedAt: z.string().optional(), sha256: z.string().length(64),
});
export type ChapterManifest = z.infer<typeof chapterManifestSchema>;

export const tokenEstimateSchema = z.object({
  calls: z.number().int().positive(), inputMin: z.number().int().nonnegative(), inputMax: z.number().int().positive(),
  outputMin: z.number().int().nonnegative(), outputMax: z.number().int().positive(), recommendedBudget: z.number().int().positive(),
});
export type TokenEstimate = z.infer<typeof tokenEstimateSchema>;

export const referenceAnalysisSchema = z.object({
  id: z.string(), mode: deconstructionModeSchema, focuses: z.array(deconstructionFocusSchema), status: z.enum(["running", "paused", "completed", "failed", "canceled"]),
  sourceHash: z.string().length(64), manifestHash: z.string().length(64), promptVersion: z.string(), tokenBudget: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().default(0), outputTokens: z.number().int().nonnegative().default(0), usageEstimated: z.boolean().default(false),
  stale: z.boolean().default(false), staleReasons: z.array(z.enum(["source", "manifest", "prompt"])).default([]),
  reportPath: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});
export type ReferenceAnalysis = z.infer<typeof referenceAnalysisSchema>;

export const referenceStateSchema = z.object({
  version: z.literal(1), referenceId: z.string().uuid(), title: z.string().min(1).max(120),
  source: z.object({ fileName: z.string().min(1).max(260), encoding: z.enum(["utf-8", "gb18030"]), sizeBytes: z.number().int().positive(), chars: z.number().int().positive(), sha256: z.string().length(64), importedAt: z.string(), rightsConfirmed: z.literal(true) }),
  manifestHash: z.string().length(64), manifestConfirmed: z.boolean(), latestAnalysisId: z.string().optional(), analyses: z.array(referenceAnalysisSchema).default([]), updatedAt: z.string(),
});
export type ReferenceState = z.infer<typeof referenceStateSchema>;

export const libraryStateSchema = z.object({ version: z.literal(1), activeJobId: z.string().optional(), activeReferenceId: z.string().uuid().optional(), updatedAt: z.string() });
export type LibraryState = z.infer<typeof libraryStateSchema>;

export const referenceJobRequestSchema = z.object({
  mode: deconstructionModeSchema, focuses: z.array(deconstructionFocusSchema).max(3).default([]), manifestHash: z.string().length(64),
  tokenBudget: z.number().int().min(MIN_REFERENCE_TOKEN_BUDGET, "硬预算不得低于 100,000 Token。").max(MAX_REFERENCE_TOKEN_BUDGET, "硬预算不得超过 50,000,000 Token。"),
}).superRefine((value, ctx) => { if (value.mode === "standard" && value.focuses.length) ctx.addIssue({ code: "custom", path: ["focuses"], message: "标准模式不运行专项复扫。" }); });
export type ReferenceJobRequest = z.infer<typeof referenceJobRequestSchema>;

export const referenceJobSchema = z.object({
  id: z.string(), referenceId: z.string().uuid(), analysisId: z.string(), mode: deconstructionModeSchema, focuses: z.array(deconstructionFocusSchema),
  status: z.enum(["queued", "running", "paused", "failed", "completed", "canceled"]), stage: z.string(), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  tokenBudget: z.number().int().positive(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), usageEstimated: z.boolean(),
  resultPath: z.string().optional(), error: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});
export type ReferenceJob = z.infer<typeof referenceJobSchema>;

export const evidenceSchema = z.object({ chapterId: z.string(), excerpt: z.string().min(1).max(240), start: z.number().int().nonnegative(), end: z.number().int().positive() });
export const chapterAnalysisSchema = z.object({
  chapterId: z.string(), title: z.string(), summary: z.string(),
  scenes: z.array(z.object({ goal: z.string(), resistance: z.string(), turn: z.string(), outcome: z.string() })).default([]),
  characterChanges: z.array(z.object({ name: z.string(), before: z.string().optional(), after: z.string(), cause: z.string() })).default([]),
  causalEvents: z.array(z.string()).default([]), worldRules: z.array(z.string()).default([]),
  threads: z.array(z.object({ text: z.string(), action: z.enum(["introduced", "advanced", "resolved"]) })).default([]),
  rewards: z.array(z.string()).default([]), endingHook: z.string(), evidence: z.array(evidenceSchema).max(8).default([]),
});
export type ChapterAnalysis = z.infer<typeof chapterAnalysisSchema>;

export const batchAnalysisSchema = z.object({
  referenceId: z.string().uuid(), analysisId: z.string(), sourceHash: z.string().length(64), manifestHash: z.string().length(64), promptVersion: z.string(), batchId: z.string(), chapters: z.array(chapterAnalysisSchema).min(1),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimated: z.boolean() }),
});
export type BatchAnalysis = z.infer<typeof batchAnalysisSchema>;

export const segmentAnalysisSchema = z.object({
  id: z.string(), title: z.string(), chapterIds: z.array(z.string()).min(1), summary: z.string(), objective: z.string(), escalation: z.array(z.string()),
  characterArcs: z.array(z.string()), promises: z.array(z.string()), payoffs: z.array(z.string()), pacing: z.string(), evidence: z.array(evidenceSchema).max(12),
});
export type SegmentAnalysis = z.infer<typeof segmentAnalysisSchema>;
