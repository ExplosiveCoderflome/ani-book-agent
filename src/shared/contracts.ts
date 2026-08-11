import { z } from "zod";
import { openingChoicesSchema, workflowIdSchema, type WorkflowId } from "../domain";

export const novelBriefSchema = z.object({
  workingTitle: z.string().min(1).max(80),
  oneSentencePremise: z.string().min(1).max(300),
  targetReaders: z.string().min(1).max(300),
  primaryReaderReward: z.string().min(1).max(300),
  protagonist: z.string().min(1).max(600),
  coreConflict: z.string().min(1).max(600),
  storyEngine: z.string().min(1).max(800),
  openingHook: z.string().min(1).max(800),
  longTermPromise: z.string().min(1).max(800),
  risks: z.array(z.string().min(1).max(300)).min(1).max(8),
});

export type NovelBrief = z.infer<typeof novelBriefSchema>;

export const createNovelInputSchema = z.object({
  title: z.string().trim().min(1).max(80).default("未命名作品"),
  approvalMode: z.enum(["milestone_approval", "auto"]).default("milestone_approval"),
});

export const openingChoicesInputSchema = openingChoicesSchema.extend({
  workingTitle: z.string().trim().min(1).max(80).optional(),
});

export const openingPresetProposalSchema = z.object({
  workingTitle: z.string().trim().min(1).max(80),
  storyDirection: z.string().trim().min(1).max(500),
  genre: z.string().trim().min(1).max(120),
  tone: z.string().trim().min(1).max(120),
  channel: z.string().trim().min(1).max(80),
  format: z.string().trim().min(1).max(80),
  primaryReward: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(500),
});

export type OpeningPresetProposal = z.infer<typeof openingPresetProposalSchema>;

export const chatChoicesSchema = z.object({
  choices: z.array(z.object({
    label: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(500),
  })).max(4),
});

export type ChatChoice = z.infer<typeof chatChoicesSchema>["choices"][number];

export const modelSettingsInputSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  credentials: z.record(z.string(), z.string()).default({}),
});

export const modelProfileNameSchema = z.enum(["chat", "planning", "drafting", "review"]);
export type ModelProfileName = z.infer<typeof modelProfileNameSchema>;
export const modelProfileSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  parameters: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(200_000).optional(),
    topP: z.number().min(0).max(1).optional(),
  }).default({}),
});
export const modelProfilesInputSchema = z.object({ profiles: z.record(modelProfileNameSchema, modelProfileSchema.optional()) });

export const novelRequestContextSchema = z.object({
  novelId: z.string().uuid().optional(),
  taskType: z.enum(["chat", "planning", "drafting", "review", "continuity"]),
  workflowId: workflowIdSchema.optional(),
  modelProfile: modelProfileNameSchema,
});
export type NovelRequestContext = z.infer<typeof novelRequestContextSchema>;

export const artifactProposalSchema = z.object({
  artifactKey: z.string().min(1),
  title: z.string().min(1),
  format: z.enum(["markdown", "yaml", "text"]),
  content: z.string(),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ArtifactProposal = z.infer<typeof artifactProposalSchema>;

export const reviewRunInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), brief: novelBriefSchema }),
  z.object({ action: z.literal("revise"), feedback: z.string().trim().min(1).max(2_000), proposal: artifactProposalSchema.optional() }),
  z.object({ action: z.literal("cancel") }),
]);

export const editNovelBriefInputSchema = z.object({
  brief: novelBriefSchema,
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const startRunInputSchema = z.object({
  workflowId: workflowIdSchema,
  target: z.string().trim().min(1).max(120).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});

export const chapterRangeInputSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
}).refine((value) => value.end >= value.start && value.end - value.start <= 99, "章节范围必须连续且最多 100 章");

export const genericReviewRunInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), proposal: artifactProposalSchema.optional(), brief: novelBriefSchema.optional() }),
  z.object({ action: z.literal("revise"), feedback: z.string().trim().min(1).max(2_000) }),
  z.object({ action: z.literal("cancel") }),
]);

export const editArtifactInputSchema = z.object({
  content: z.string(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const autoDirectorInputSchema = z.object({
  startChapter: z.number().int().positive().optional(),
  endChapter: z.number().int().positive(),
  autoApproveMilestones: z.boolean().default(false),
}).refine((value) => value.endChapter >= (value.startChapter ?? 1) && value.endChapter - (value.startChapter ?? 1) <= 99, "自动导演章节范围必须连续且最多 100 章");

export const promptVersion = "novel.brief@v2" as const;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    fieldErrors?: Record<string, string[]>;
  };
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  label: string;
  description?: string;
  envVar: string[];
  connected: boolean;
  docUrl?: string;
  models: Array<{ id: string; name: string }>;
}

export interface NovelSummary {
  id: string;
  title: string;
  updatedAt: string;
  nextStep: string;
}

export interface RunView {
  runId: string;
  novelId: string;
  workflowId?: WorkflowId;
  target?: string;
  status: "running" | "awaiting_review" | "committed" | "failed" | "canceled";
  proposal?: NovelBrief;
  artifactProposal?: ArtifactProposal;
  currentStep?: string;
  artifactSha256?: string;
  exportPath?: string;
  chapterCount?: number;
  error?: ApiErrorBody["error"];
}
