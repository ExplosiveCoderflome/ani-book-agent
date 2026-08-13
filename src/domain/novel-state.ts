import { z } from "zod";

export const untitledNovelTitle = "未命名作品";

export const workflowIds = [
  "novel-brief",
  "story-bible",
  "world-bible",
  "character-cast",
  "volume-strategy",
  "volume-outline",
  "volume-handoff",
  "completion-audit",
  "chapter-planning",
  "quality-repair",
  "chapter-production",
  "chapter-range",
  "novel-export",
  "auto-director",
] as const;

export const workflowIdSchema = z.enum(workflowIds);
export type WorkflowId = z.infer<typeof workflowIdSchema>;

export const bookStages = [
  "novel_brief",
  "story_bible",
  "world_bible",
  "character_cast",
  "volume_strategy",
  "volume_outline",
] as const;

export const chapterStages = [
  "chapter_plan",
  "context_package",
  "chapter_draft",
  "humanization_revision",
  "chapter_review",
  "continuity_update",
] as const;

export const volumeStages = ["volume_handoff", "completion_audit"] as const;

export const optionalChapterStages = ["quality_repair"] as const;

export const volumePlanStatusSchema = z.enum(["active", "completed"]);
export const volumePlanSchema = z.object({
  number: z.number().int().positive(),
  startChapter: z.number().int().positive(),
  endChapter: z.number().int().positive(),
  final: z.boolean().default(false),
  status: volumePlanStatusSchema.default("active"),
}).refine((value) => value.endChapter >= value.startChapter, "卷结束章节不能早于开始章节");
export type VolumePlan = z.infer<typeof volumePlanSchema>;

export const completionAuditResultSchema = z.object({
  verdict: z.enum(["pass", "block"]),
  summary: z.string().min(1).max(2_000),
  qualityDebt: z.array(z.object({ chapter: z.number().int().positive(), issue: z.string().min(1).max(500) })).default([]),
  missingChapters: z.array(z.number().int().positive()).default([]),
  unresolvedPromises: z.array(z.string().min(1).max(500)).default([]),
  continuityAnomalies: z.array(z.string().min(1).max(500)).default([]),
});
export type CompletionAuditResult = z.infer<typeof completionAuditResultSchema>;

export const productionStageSchema = z.enum([...bookStages, ...volumeStages, ...chapterStages, ...optionalChapterStages]);
export type ProductionStage = z.infer<typeof productionStageSchema>;
export const artifactStatusSchema = z.enum(["missing", "in_progress", "ready", "stale", "blocked"]);
export const artifactSourceSchema = z.enum(["ai_generated", "user_edited", "imported"]);

export const artifactRecordSchema = z.object({
  key: z.string().optional(),
  stage: productionStageSchema.optional(),
  path: z.string().min(1),
  status: artifactStatusSchema,
  source: artifactSourceSchema.optional(),
  protected: z.boolean().default(false),
  userEdited: z.boolean().optional(),
  sha256: z.string().optional(),
  inputHash: z.string().optional(),
  promptVersion: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  committedAt: z.string().optional(),
});

export type ArtifactState = z.infer<typeof artifactRecordSchema>;

export const openingChoicesSchema = z.object({
  channel: z.string().min(1),
  format: z.string().min(1),
  primaryReward: z.string().min(1),
  storyDirection: z.string().min(1).max(500).optional(),
  genre: z.string().min(1).max(120).optional(),
  tone: z.string().min(1).max(120).optional(),
});

export const novelStateSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  novelId: z.string().min(1),
  title: z.string().min(1).max(80),
  approvalMode: z.enum(["milestone_approval", "auto"]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  currentChapter: z.number().int().positive(),
  approvedChapterEnd: z.number().int().nonnegative(),
  currentVolume: z.number().int().positive().default(1),
  volumes: z.record(z.string(), volumePlanSchema).default({}),
  productionStatus: z.enum(["in_progress", "awaiting_completion_review", "completed"]).default("in_progress"),
  completionAudit: completionAuditResultSchema.optional(),
  openingChoices: openingChoicesSchema.optional(),
  activeRunId: z.string().optional(),
  artifacts: z.record(z.string(), artifactRecordSchema),
  continuity: z.object({
    lastCommittedChapter: z.number().int().nonnegative().default(0),
    revision: z.number().int().nonnegative().default(0),
  }).optional(),
});

export type NovelState = z.infer<typeof novelStateSchema>;

export const nextActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("collect_opening_choices"), reason: z.string() }),
  z.object({ type: z.literal("configure_volume"), volume: z.number().int().positive(), startChapter: z.number().int().positive(), suggestedEndChapter: z.number().int().positive(), reason: z.string() }),
  z.object({ type: z.literal("approve_chapter_range"), chapter: z.number().int().positive(), reason: z.string() }),
  z.object({ type: z.literal("complete_novel"), volume: z.number().int().positive(), chapter: z.number().int().positive(), reason: z.string() }),
  z.object({ type: z.literal("completion_blocked"), volume: z.number().int().positive(), chapter: z.number().int().positive(), blockers: z.array(z.string().min(1)).min(1), workflowId: z.literal("completion-audit"), reason: z.string() }),
  z.object({
    type: z.enum(["produce_artifact", "refresh_artifact"]),
    stage: productionStageSchema,
    artifactKey: z.string(),
    workflowId: workflowIdSchema.optional(),
    reason: z.string(),
  }),
]);

export type NextAction = z.infer<typeof nextActionSchema>;

export function artifactKey(stage: ProductionStage, chapter = 1): string {
  return [...chapterStages, ...optionalChapterStages].includes(stage as (typeof chapterStages)[number] | (typeof optionalChapterStages)[number])
    ? `chapter:${chapter}:${stage}`
    : `book:${stage}`;
}

export function volumeOutlineKey(volume: number): string { return `volume:${volume}:outline`; }
export function volumeHandoffKey(volume: number): string { return `volume:${volume}:handoff`; }
export function completionAuditKey(): string { return "book:completion_audit"; }

export function completionAuditBlockers(state: NovelState): string[] {
  if (state.schemaVersion === 1) return [];
  const volume = state.volumes[String(state.currentVolume)];
  if (!volume || !volume.final || volume.status !== "completed") return [`第 ${state.currentVolume} 卷尚未完成最终卷验收范围。`];
  const blockers: string[] = [];
  for (const stage of bookStages.filter((item) => item !== "volume_outline")) {
    const artifact = state.artifacts[artifactKey(stage)];
    if (!artifact || artifact.status !== "ready") blockers.push(`缺少稳定的书级工件：${stage}。`);
  }
  const outline = state.artifacts[volumeOutlineKey(volume.number)] ?? (volume.number === 1 ? state.artifacts["book:volume_outline"] : undefined);
  if (!outline || outline.status !== "ready") blockers.push(`缺少第 ${volume.number} 卷的稳定卷骨架。`);
  for (let chapter = volume.startChapter; chapter <= volume.endChapter; chapter += 1) {
    for (const stage of ["humanization_revision", "chapter_review", "continuity_update"] as const) {
      const artifact = state.artifacts[`chapter:${chapter}:${stage}`];
      if (!artifact || artifact.status !== "ready") blockers.push(`第 ${chapter} 章缺少稳定的${stage === "humanization_revision" ? "正文" : stage === "chapter_review" ? "审查" : "连续性"}工件。`);
    }
    const debt = state.artifacts[`chapter:${chapter}:quality_debt`];
    const repair = state.artifacts[`chapter:${chapter}:quality_repair`];
    if (debt?.status === "ready" && (!repair || repair.status !== "ready")) blockers.push(`第 ${chapter} 章仍有未关闭的质量债。`);
  }
  return blockers;
}

export function completionAuditReportBlockers(result: CompletionAuditResult): string[] {
  const blockers = [
    ...result.qualityDebt.map((item) => `第 ${item.chapter} 章质量债：${item.issue}`),
    ...result.missingChapters.map((chapter) => `完本验收发现第 ${chapter} 章缺失或不完整。`),
    ...result.unresolvedPromises.map((item) => `未兑现承诺：${item}`),
    ...result.continuityAnomalies.map((item) => `连续性异常：${item}`),
  ];
  return result.verdict === "block" && !blockers.length ? [result.summary] : blockers;
}

export const stageWorkflow: Record<ProductionStage, WorkflowId> = {
  novel_brief: "novel-brief",
  story_bible: "story-bible",
  world_bible: "world-bible",
  character_cast: "character-cast",
  volume_strategy: "volume-strategy",
  volume_outline: "volume-outline",
  volume_handoff: "volume-handoff",
  completion_audit: "completion-audit",
  chapter_plan: "chapter-planning",
  context_package: "chapter-production",
  chapter_draft: "chapter-production",
  humanization_revision: "chapter-production",
  chapter_review: "chapter-production",
  continuity_update: "chapter-production",
  quality_repair: "quality-repair",
};
