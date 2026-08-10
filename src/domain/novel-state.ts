import { z } from "zod";

export const untitledNovelTitle = "未命名作品";

export const workflowIds = [
  "novel-brief",
  "story-bible",
  "world-bible",
  "character-cast",
  "volume-strategy",
  "volume-outline",
  "chapter-planning",
  "quality-repair",
  "chapter-production",
  "chapter-range",
  "novel-export",
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

export const optionalChapterStages = ["quality_repair"] as const;

export const productionStageSchema = z.enum([...bookStages, ...chapterStages, ...optionalChapterStages]);
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
  z.object({ type: z.literal("approve_chapter_range"), chapter: z.number().int().positive(), reason: z.string() }),
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

export const stageWorkflow: Record<ProductionStage, WorkflowId> = {
  novel_brief: "novel-brief",
  story_bible: "story-bible",
  world_bible: "world-bible",
  character_cast: "character-cast",
  volume_strategy: "volume-strategy",
  volume_outline: "volume-outline",
  chapter_plan: "chapter-planning",
  context_package: "chapter-production",
  chapter_draft: "chapter-production",
  humanization_revision: "chapter-production",
  chapter_review: "chapter-production",
  continuity_update: "chapter-production",
  quality_repair: "quality-repair",
};
