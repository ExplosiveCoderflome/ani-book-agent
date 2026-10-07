import { z } from "zod";

export const deconstructionModeSchema = z.enum(["standard", "deep"]);
export const deconstructionFocusSchema = z.enum(["structure", "characters", "pacing_hooks"]);
export const referenceAnalysisPresetSchema = z.enum(["quick", "standard", "complete"]);
export type ReferenceAnalysisPreset = z.infer<typeof referenceAnalysisPresetSchema>;
export const REFERENCE_ANALYSIS_SECTIONS = [
  { key: "overview", title: "拆书总览", reusable: false },
  { key: "plot_structure", title: "剧情结构", reusable: true },
  { key: "timeline", title: "故事时间线", reusable: false },
  { key: "character_system", title: "人物系统", reusable: true },
  { key: "worldbuilding", title: "世界观与设定", reusable: false },
  { key: "themes", title: "主题表达", reusable: false },
  { key: "style_technique", title: "文风与技法", reusable: true },
  { key: "market_highlights", title: "商业化卖点", reusable: true },
] as const;
export const referenceAnalysisSectionKeySchema = z.enum(REFERENCE_ANALYSIS_SECTIONS.map((item) => item.key));
export type ReferenceAnalysisSectionKey = z.infer<typeof referenceAnalysisSectionKeySchema>;
export const referenceAnalysisPresetSections: Record<ReferenceAnalysisPreset, ReferenceAnalysisSectionKey[]> = {
  quick: ["overview", "plot_structure", "character_system", "style_technique"],
  standard: ["overview", "plot_structure", "character_system", "worldbuilding", "themes", "style_technique", "market_highlights"],
  complete: ["overview", "plot_structure", "timeline", "character_system", "worldbuilding", "themes", "style_technique", "market_highlights"],
};
export const referenceAnalysisFieldLabels: Record<string, string> = {
  positioning: "一句话定位", genre: "题材与受众", strengths: "作品优势", risks: "风险与边界",
  mainline: "主线梗概", phases: "阶段推进", escalation: "冲突升级", highlights: "高光设计", reusablePatterns: "可复用套路",
  protagonist: "主角定位", supportingRoles: "配角功能", opposingForces: "对立力量", relationships: "关系张力", growthArcs: "成长弧线", characterHighlights: "人物高光", characterCandidates: "角色候选",
  framework: "世界框架", rules: "规则系统", plotSupport: "剧情支撑", coreThemes: "核心主题", motifs: "象征母题", emotionalTone: "情绪基调", presentation: "呈现方式",
  narrativePov: "叙事视角", languageStyle: "语言风格", descriptionMethods: "描写方式", dialoguePatterns: "对话特征", rhythmControl: "节奏控制", hookDesigns: "钩子设计", reusableTechniques: "可复用写法",
  hookPoints: "读者爽点", clickDrivers: "点击驱动", characterSellingPoints: "人物卖点", genreSellingPoints: "题材卖点", targetReaders: "目标读者", commercialRisks: "商业化风险",
  nodes: "关键节点", eventOrder: "事件先后关系", phaseDivisions: "主线阶段划分", stateChanges: "状态变化节点",
  title: "标题", mechanism: "作用机制", fitFor: "适用场景", doNotCopy: "不可照搬", adaptationHint: "适配提示", evidence: "原文证据",
  name: "角色", role: "角色功能", importance: "重要度", summary: "简述", chapterIds: "出场章节", profile: "角色档案",
  desire: "核心欲望", pressure: "主要压力", relationshipMap: "关系网络", arc: "变化轨迹", keyScenes: "关键场景", reusableDesign: "可借鉴的人物设计", version: "版本", createdAt: "生成时间",
};
export const MIN_REFERENCE_TOKEN_BUDGET = 100_000;
export const MAX_REFERENCE_TOKEN_BUDGET = 50_000_000;
export type DeconstructionMode = z.infer<typeof deconstructionModeSchema>;
export type DeconstructionFocus = z.infer<typeof deconstructionFocusSchema>;

export const chapterPatternSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(64),
  name: z.string().trim().min(1).max(40),
  pattern: z.string().trim().min(2).max(240).refine((value) => value.startsWith("^"), "章节正则必须从 ^ 开始，只匹配行首。").superRefine((value, ctx) => {
    try {
      const regex = new RegExp(value, "iu");
      if (regex.test("")) ctx.addIssue({ code: "custom", message: "章节正则不能匹配空行。" });
    } catch {
      ctx.addIssue({ code: "custom", message: "章节正则语法无效。" });
    }
  }),
  enabled: z.boolean().default(true),
  source: z.enum(["builtin", "author", "ai"]),
});
export const chapterParserConfigSchema = z.object({
  version: z.literal(1),
  patterns: z.array(chapterPatternSchema).min(1).max(20),
}).superRefine((value, ctx) => {
  if (new Set(value.patterns.map((item) => item.id)).size !== value.patterns.length) ctx.addIssue({ code: "custom", path: ["patterns"], message: "章节规则 ID 不能重复。" });
  if (!value.patterns.some((item) => item.enabled)) ctx.addIssue({ code: "custom", path: ["patterns"], message: "至少启用一条章节规则。" });
});
export const chapterPatternSuggestionSchema = z.object({
  name: z.string().trim().min(1).max(40),
  pattern: chapterPatternSchema.shape.pattern,
  explanation: z.string().trim().min(1).max(400),
});
export type ChapterPattern = z.infer<typeof chapterPatternSchema>;
export type ChapterParserConfig = z.infer<typeof chapterParserConfigSchema>;
export type ChapterPatternSuggestion = z.infer<typeof chapterPatternSuggestionSchema>;
export const chapterRangeSchema = z.object({
  fromChapter: z.number().int().positive(),
  toChapter: z.number().int().positive(),
}).refine((value) => value.toChapter >= value.fromChapter, { path: ["toChapter"], message: "结束章节不能早于起始章节。" });
export type ChapterRange = z.infer<typeof chapterRangeSchema>;

export function normalizeChapterPatternSuggestion(
  value: { name: string; pattern: string; explanation: string },
  sample: string,
): ChapterPatternSuggestion | undefined {
  let pattern = value.pattern.trim().replace(/^```(?:regex|regexp|javascript|js)?\s*/i, "").replace(/\s*```$/, "").trim();
  const delimited = pattern.match(/^\/([\s\S]+)\/[a-z]*$/i);
  if (delimited) pattern = delimited[1]!;
  const candidates = [pattern, ...(pattern.includes("\\\\") ? [pattern.replaceAll("\\\\", "\\")] : [])];
  const lines = sample.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const parsed = chapterPatternSuggestionSchema.safeParse({ ...value, pattern: candidate });
    if (!parsed.success) continue;
    const regex = new RegExp(parsed.data.pattern, "iu");
    if (lines.some((line) => regex.test(line.slice(0, 160)))) return parsed.data;
  }
  return undefined;
}

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
  preset: referenceAnalysisPresetSchema.default("standard"), sectionKeys: z.array(referenceAnalysisSectionKeySchema).default(referenceAnalysisPresetSections.standard),
  chapterRange: chapterRangeSchema.optional(),
  sourceHash: z.string().length(64), manifestHash: z.string().length(64), promptVersion: z.string(), tokenBudget: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().default(0), outputTokens: z.number().int().nonnegative().default(0), usageEstimated: z.boolean().default(false),
  stale: z.boolean().default(false), staleReasons: z.array(z.enum(["source", "manifest", "prompt"])).default([]),
  reportPath: z.string().optional(), radarPath: z.string().optional(), characterProfiles: z.array(z.object({ name: z.string(), status: z.enum(["candidate", "generating", "generated", "failed"]), updatedAt: z.string(), error: z.string().optional() })).default([]), createdAt: z.string(), updatedAt: z.string(),
});
export type ReferenceAnalysis = z.infer<typeof referenceAnalysisSchema>;

export const referenceStateSchema = z.object({
  version: z.literal(1), referenceId: z.string().uuid(), title: z.string().min(1).max(120),
  source: z.object({ fileName: z.string().min(1).max(260), encoding: z.enum(["utf-8", "gb18030"]), sizeBytes: z.number().int().positive(), chars: z.number().int().positive(), sha256: z.string().length(64), importedAt: z.string() }),
  manifestHash: z.string().length(64), manifestConfirmed: z.boolean(), latestAnalysisId: z.string().optional(), analyses: z.array(referenceAnalysisSchema).default([]), updatedAt: z.string(),
});
export type ReferenceState = z.infer<typeof referenceStateSchema>;

export const libraryStateSchema = z.object({ version: z.literal(1), activeJobId: z.string().optional(), activeReferenceId: z.string().uuid().optional(), updatedAt: z.string() });
export type LibraryState = z.infer<typeof libraryStateSchema>;

export const referenceJobRequestSchema = z.object({
  preset: referenceAnalysisPresetSchema.default("standard"), mode: deconstructionModeSchema.default("standard"), focuses: z.array(deconstructionFocusSchema).max(3).default([]), manifestHash: z.string().length(64),
  chapterRange: chapterRangeSchema.optional(),
  tokenBudget: z.number().int().min(MIN_REFERENCE_TOKEN_BUDGET, "硬预算不得低于 100,000 Token。").max(MAX_REFERENCE_TOKEN_BUDGET, "硬预算不得超过 50,000,000 Token。"),
});
export type ReferenceJobRequest = z.infer<typeof referenceJobRequestSchema>;

export const referenceJobSchema = z.object({
  id: z.string(), referenceId: z.string().uuid(), analysisId: z.string(), mode: deconstructionModeSchema, focuses: z.array(deconstructionFocusSchema),
  chapterRange: chapterRangeSchema.optional(),
  status: z.enum(["queued", "running", "paused", "failed", "completed", "canceled"]), stage: z.string(), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  tokenBudget: z.number().int().positive(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), usageEstimated: z.boolean(),
  resultPath: z.string().optional(), error: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
  progress: z.object({
    phaseIndex: z.number().int().positive(), phaseTotal: z.number().int().positive(), detail: z.string(),
    chaptersCovered: z.number().int().nonnegative(), chaptersTotal: z.number().int().nonnegative(), currentChapter: z.string().optional(),
    batchesCompleted: z.number().int().nonnegative(), batchesTotal: z.number().int().nonnegative(),
    segmentsCompleted: z.number().int().nonnegative(), segmentsTotal: z.number().int().nonnegative(),
    macrosCompleted: z.number().int().nonnegative(), macrosTotal: z.number().int().nonnegative(),
    focusesCompleted: z.number().int().nonnegative(), focusesTotal: z.number().int().nonnegative(), reportCompleted: z.boolean(),
  }).optional(),
});
export type ReferenceJob = z.infer<typeof referenceJobSchema>;

export const evidenceSchema = z.object({ chapterId: z.string(), excerpt: z.string().min(1).max(240), start: z.number().int().nonnegative(), end: z.number().int().positive() });
export const transferableInsightSchema = z.object({ id: z.string(), title: z.string().min(1), mechanism: z.string().min(1), fitFor: z.array(z.string()).min(1), doNotCopy: z.array(z.string()).min(1), adaptationHint: z.string().min(1), evidence: z.array(evidenceSchema).max(4).default([]) });
export const characterCandidateSchema = z.object({ name: z.string().min(1), role: z.string().min(1), importance: z.enum(["main", "major", "supporting"]), summary: z.string().min(1), chapterIds: z.array(z.string()).default([]) });
export const referenceSectionSchema = z.object({ version: z.literal(1), key: referenceAnalysisSectionKeySchema, title: z.string().min(1), summary: z.string().min(1), content: z.string().min(1), structuredData: z.record(z.string(), z.unknown()).default({}), evidence: z.array(evidenceSchema).max(20).default([]), insights: z.array(transferableInsightSchema).max(12).default([]), characterCandidates: z.array(characterCandidateSchema).default([]), createdAt: z.string() });
export type ReferenceSection = z.infer<typeof referenceSectionSchema>;
export const referenceCharacterProfileSchema = z.object({ version: z.literal(1), name: z.string().min(1), role: z.string().min(1), summary: z.string().min(1), desire: z.string().min(1), pressure: z.string().min(1), relationshipMap: z.array(z.string()).default([]), arc: z.array(z.string()).default([]), keyScenes: z.array(z.string()).default([]), reusableDesign: z.string().min(1), evidence: z.array(evidenceSchema).max(12).default([]), createdAt: z.string() });
export type ReferenceCharacterProfile = z.infer<typeof referenceCharacterProfileSchema>;
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
  referenceId: z.string().uuid(), analysisId: z.string(), sourceHash: z.string().length(64), manifestHash: z.string().length(64), promptVersion: z.string(), batchId: z.string(),
  ranges: z.array(z.object({ chapterId: z.string(), title: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive() })).min(1),
  chapters: z.array(chapterAnalysisSchema).min(1),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimated: z.boolean() }),
});
export type BatchAnalysis = z.infer<typeof batchAnalysisSchema>;

export const segmentAnalysisSchema = z.object({
  id: z.string(), title: z.string(), chapterIds: z.array(z.string()).min(1), summary: z.string(), objective: z.string(), escalation: z.array(z.string()),
  characterArcs: z.array(z.string()), promises: z.array(z.string()), payoffs: z.array(z.string()), pacing: z.string(), evidence: z.array(evidenceSchema).max(12),
});
export type SegmentAnalysis = z.infer<typeof segmentAnalysisSchema>;
