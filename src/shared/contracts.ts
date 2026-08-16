import { z } from "zod";
import { openingChoicesSchema, workflowIdSchema, type NextAction, type NovelState, type WorkflowId } from "../domain";

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
  })).max(5),
});

export type ChatChoice = z.infer<typeof chatChoicesSchema>["choices"][number];

export const openingSeedsSchema = z.object({ choices: z.array(z.object({
  label: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500),
})).length(5) });
export type OpeningSeed = z.infer<typeof openingSeedsSchema>["choices"][number];

export const modelSettingsInputSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  credentials: z.record(z.string(), z.string()).default({}),
});

export const modelProfileNameSchema = z.enum(["chat", "planning", "drafting", "review"]);
export type ModelProfileName = z.infer<typeof modelProfileNameSchema>;

export const skillScopeSchema = z.enum(["book", "volume", "chapter"]);
export const skillPurposeSchema = z.enum(["discovery", "planning", "drafting", "review", "continuity", "asset"]);
export const skillDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/),
  version: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  scope: skillScopeSchema,
  purpose: skillPurposeSchema,
  inputContract: z.array(z.string().min(1).max(120)).max(30),
  outputContract: z.string().min(1).max(240),
  contextBudget: z.number().int().positive().max(64_000),
  allowedTools: z.array(z.string().min(1).max(120)).max(30),
  stopConditions: z.array(z.string().min(1).max(240)).max(20),
  prompt: z.string().min(1).max(40_000),
  enabled: z.boolean().default(true),
  source: z.enum(["builtin", "project", "user"]).default("project"),
});
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

export const agentProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/),
  version: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  purpose: skillPurposeSchema,
  skillIds: z.array(z.string().min(1).max(120)).max(30),
  toolIds: z.array(z.string().min(1).max(120)).max(30),
  modelProfile: modelProfileNameSchema,
  enabled: z.boolean().default(true),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export const toolCapabilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,100}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  kind: z.enum(["read", "write_workspace", "present", "workflow"]),
  approval: z.enum(["none", "author", "workflow"]),
  inputContract: z.array(z.string().min(1).max(120)).max(20),
  outputContract: z.string().min(1).max(240),
});
export type ToolCapability = z.infer<typeof toolCapabilitySchema>;

export const projectRecipeSchema = z.object({
  version: z.string().min(1).max(40),
  activeSkillIds: z.array(z.string().min(1).max(120)).max(60),
  activeAgentProfileIds: z.array(z.string().min(1).max(120)).max(20),
  approvalMode: z.enum(["milestone_approval", "auto"]),
  chapterBatchSize: z.number().int().min(1).max(100),
  settings: z.record(z.string(), z.string().max(500)).default({}),
});
export type ProjectRecipe = z.infer<typeof projectRecipeSchema>;

export const assetTypeSchema = z.enum(["brief", "story", "world", "character", "volume", "chapter", "continuity", "promise", "relationship", "reference", "style", "workspace"]);
export const assetStatusSchema = z.enum(["missing", "in_progress", "ready", "stale", "blocked"]);
export const assetRecordSchema = z.object({
  id: z.string().min(1).max(180),
  type: assetTypeSchema,
  title: z.string().min(1).max(160),
  path: z.string().min(1).max(400),
  status: assetStatusSchema,
  version: z.number().int().positive(),
  sha256: z.string().length(64).optional(),
  source: z.enum(["ai_generated", "user_edited", "imported", "derived"]).default("ai_generated"),
  protected: z.boolean().default(false),
  dependsOn: z.array(z.string().min(1)).default([]),
  referencedBy: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1).max(60)).max(30).default([]),
  updatedAt: z.string().optional(),
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;
export const novelFileKindSchema = z.enum(["markdown", "yaml", "json", "text", "binary"]);
export const novelFileRecordSchema = z.object({
  path: z.string().min(1).max(400),
  kind: novelFileKindSchema,
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  artifactKey: z.string().min(1).optional(),
});
export type NovelFileRecord = z.infer<typeof novelFileRecordSchema>;
export const workspaceFileEditInputSchema = z.object({
  path: z.string().trim().min(1).max(240),
  content: z.string().max(200_000),
  expectedSha256: z.string().length(64).optional(),
});
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

export const volumePlanInputSchema = z.object({
  number: z.number().int().positive(),
  startChapter: z.number().int().positive(),
  endChapter: z.number().int().positive(),
  final: z.boolean().default(false),
}).refine((value) => value.endChapter >= value.startChapter, "卷结束章节不能早于开始章节");

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
  executionStatus: "running" | "suspended" | "succeeded" | "failed" | "canceled";
  attempt: number;
  recovered: boolean;
  proposal?: NovelBrief;
  artifactProposal?: ArtifactProposal;
  currentStep?: string;
  artifactSha256?: string;
  exportPath?: string;
  chapterCount?: number;
  error?: ApiErrorBody["error"];
}

export type WorkspacePhase = "discovery" | "planning" | "volume" | "chapter" | "completion";

export type WorkspaceFocus =
  | { kind: "conversation"; title: string }
  | { kind: "next_action"; title: string }
  | { kind: "generation"; title: string }
  | { kind: "review"; title: string; artifactKey: string }
  | { kind: "artifact"; title: string; artifactKey: string }
  | { kind: "blocked"; title: string; message: string };

export interface WorkspaceProjection {
  novel: NovelState;
  phase: WorkspacePhase;
  focus: WorkspaceFocus;
  production: Array<{
    id: string;
    label: string;
    status: "locked" | "pending" | "running" | "review" | "ready" | "stale" | "blocked";
    artifactKey?: string;
  }>;
  run?: Pick<RunView, "runId" | "workflowId" | "status" | "currentStep" | "error" | "attempt" | "recovered">;
  review?: {
    runId: string;
    artifactKey: string;
    proposal: ArtifactProposal;
    editable: boolean;
  };
  nextAction: NextAction;
}
