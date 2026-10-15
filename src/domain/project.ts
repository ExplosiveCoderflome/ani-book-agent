import { z } from "zod";
import { actualTensionObservationSchema } from "./tension-curve";

export const novelPhaseSchema = z.enum(["discovery", "writing", "completed"]);
export const approvalModeSchema = z.enum(["milestone", "autonomous_opening"]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export const fileSourceSchema = z.enum(["agent", "author", "imported"]);
export const fileRecordSchema = z.object({
  sha256: z.string().length(64),
  version: z.number().int().positive(),
  source: fileSourceSchema,
  protected: z.boolean(),
  updatedAt: z.string(),
});

export const productionAuthorizationSchema = z.object({
  jobId: z.string().min(1),
  goal: z.enum(["write_chapters", "review_project", "export"]),
  scope: z.object({ fromChapter: z.number().int().positive().optional(), toChapter: z.number().int().positive().optional(), paths: z.array(z.string()).max(200).optional() }),
  interactionMode: z.enum(["standard", "autonomous_opening"]),
  revoked: z.boolean().default(false),
  confirmedPlan: z.object({ volume: z.number().int().positive(), planSha256: z.string().length(64), curveSha256: z.string().length(64) }).optional(),
});
export type ProductionAuthorization = z.infer<typeof productionAuthorizationSchema>;

export const novelStateSchema = z.object({
  schemaVersion: z.literal(2),
  novelId: z.string().uuid(),
  title: z.string().trim().min(1).max(80),
  phase: novelPhaseSchema,
  currentVolume: z.number().int().positive(),
  nextChapter: z.number().int().positive(),
  activeJobId: z.string().optional(),
  productionAuthorization: productionAuthorizationSchema.optional(),
  approvalMode: approvalModeSchema,
  files: z.record(z.string(), fileRecordSchema),
  appliedProposalIds: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type NovelState = z.infer<typeof novelStateSchema>;
export interface NovelSummary { novelId: string; title: string; phase: "discovery" | "writing" | "completed"; nextChapter: number; updatedAt: string }
export interface NovelFileView { path: string; sha256: string; version: number; source: "agent" | "author" | "imported"; protected: boolean; updatedAt: string; size: number }
export interface FileContent extends NovelFileView { content: string }

export const ledgerSchema = z.object({
  version: z.literal(1),
  decisions: z.array(z.object({ id: z.string(), text: z.string(), source: z.string() })).default([]),
  characters: z.array(z.object({
    id: z.string(), name: z.string(), role: z.string(), goal: z.string(), state: z.string(),
    knowledge: z.array(z.string()).default([]), relationships: z.array(z.string()).default([]),
  })).default([]),
  worldRules: z.array(z.object({ id: z.string(), rule: z.string(), exceptions: z.array(z.string()).default([]) })).default([]),
  openThreads: z.array(z.object({
    id: z.string(), kind: z.enum(["promise", "mystery", "conflict"]), text: z.string(),
    status: z.enum(["open", "advanced", "resolved"]), introducedChapter: z.number().int().nonnegative(), lastAdvancedChapter: z.number().int().nonnegative(),
  })).default([]),
  continuity: z.array(z.object({ chapter: z.number().int().positive(), changes: z.array(z.string()) })).default([]),
});
export type NovelLedger = z.infer<typeof ledgerSchema>;

export const patchChangeSchema = z.object({
  operation: z.enum(["create", "replace"]),
  path: z.string().trim().min(1).max(240),
  baseSha256: z.string().length(64).optional(),
  content: z.string().max(500_000),
  overrideLockedNodes: z.boolean().optional(),
});
export const patchProposalSchema = z.object({
  id: z.string().uuid(),
  novelId: z.string().uuid(),
  intent: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(1_000),
  changes: z.array(patchChangeSchema).min(1).max(20),
  approval: z.enum(["auto", "author"]),
  status: z.enum(["pending", "approved", "rejected", "applied"]),
  createdAt: z.string(),
});
export type PatchProposal = z.infer<typeof patchProposalSchema>;

export const productionGoalSchema = z.enum(["write_chapters", "revise_files", "review_project", "export"]);
export const productionScopeSchema = z.object({
  fromChapter: z.number().int().positive().optional(),
  toChapter: z.number().int().positive().optional(),
  paths: z.array(z.string()).max(200).optional(),
});
export const productionJobRequestSchema = z.object({
  goal: productionGoalSchema,
  scope: productionScopeSchema.default({}),
  brief: z.string().trim().min(1).max(4_000).optional(),
});
export type ProductionJobRequest = z.infer<typeof productionJobRequestSchema>;
export const productionInteractionModeSchema = z.enum(["standard", "autonomous_opening"]);
export type ProductionInteractionMode = z.infer<typeof productionInteractionModeSchema>;
export const productionJobSchema = z.object({
  id: z.string(), novelId: z.string().uuid(), goal: productionGoalSchema,
  scope: productionScopeSchema,
  brief: z.string().optional(),
  status: z.enum(["queued", "running", "awaiting_author", "failed", "completed", "canceled"]),
  interactionMode: productionInteractionModeSchema.default("standard"),
  retryOf: z.string().min(1).optional(),
  attempt: z.number().int().positive().default(1),
  modelRetry: z.object({
    label: z.string().min(1), attempt: z.number().int().positive(), maxRetries: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(), updatedAt: z.string(),
  }).optional(),
  cursor: z.number().int().positive().optional(), checkpoint: z.enum(["curve_confirmation", "chapter_review"]).optional(), baseStateHash: z.string().length(64), proposalId: z.string().optional(),
  resultPath: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }).optional(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type ProductionJob = z.infer<typeof productionJobSchema>;

export const allowedOperationSchema = z.enum(["propose_blueprint", "write_chapters", "revise_files", "review_project", "export", "complete"]);
export const operationAvailabilitySchema = z.object({
  allowedOperations: z.array(allowedOperationSchema),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  activeJob: productionJobSchema.optional(),
});
export type OperationAvailability = z.infer<typeof operationAvailabilitySchema>;
export interface ProjectSnapshot { novel: NovelState; availability: OperationAvailability; files: NovelFileView[]; characterStates: NovelLedger["characters"]; activeJob?: ProductionJob }

export const continuityDeltaSchema = z.object({
  characterUpdates: z.array(z.object({ id: z.string(), name: z.string().optional(), role: z.string().optional(), goal: z.string().optional(), state: z.string().optional(), knowledge: z.array(z.string()).default([]), relationships: z.array(z.string()).default([]) })).default([]),
  worldRules: z.array(z.object({ id: z.string(), rule: z.string(), exceptions: z.array(z.string()).default([]) })).default([]),
  threads: z.array(z.object({ id: z.string(), kind: z.enum(["promise", "mystery", "conflict"]), text: z.string(), status: z.enum(["open", "advanced", "resolved"]) })).default([]),
  changes: z.array(z.string()).default([]),
});

const missingCharacterAppearance = /^(?:暂无|未知|待补充|待确认|待作者确认|未设定)$/;
export function hasDefinedCharacterAppearance(content: string) {
  return content.split(/\r?\n/).some((line) => {
    const field = line.trim().replace(/^(?:[-*]\s+|#{1,6}\s+)/, "");
    const match = /^外貌与辨识特征\s*[：:]\s*(.+)$/.exec(field);
    const value = match?.[1]?.trim() ?? "";
    return value.length >= 4 && !missingCharacterAppearance.test(value);
  });
}

export const characterProfileContentSchema = z.string().min(80).max(12_000).refine(
  hasDefinedCharacterAppearance,
  { message: "角色档案必须包含非空的“外貌与辨识特征”字段，不能使用暂无、未知或待确认占位。" },
);

export const characterProfileCreateSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  content: characterProfileContentSchema,
});

export const criticResultSchema = z.object({
  verdict: z.enum(["accepted", "repair", "replan"]),
  summary: z.string(),
  issues: z.array(z.object({ evidence: z.string(), severity: z.enum(["low", "medium", "high", "critical"]), repair: z.string() })).default([]),
  continuityDelta: continuityDeltaSchema,
  newCharacterProfiles: z.array(characterProfileCreateSchema).max(5).default([]),
  actualTension: actualTensionObservationSchema,
});
export type CriticResult = z.infer<typeof criticResultSchema>;

export function newNovelState(title: string, novelId: string, now = new Date().toISOString(), approvalMode: ApprovalMode = "milestone"): NovelState {
  return novelStateSchema.parse({ schemaVersion: 2, novelId, title, phase: "discovery", currentVolume: 1, nextChapter: 1, approvalMode, files: {}, appliedProposalIds: [], updatedAt: now });
}

const roots = new Set(["book", "volumes", "chapters", "workspace", "exports"]);
export function normalizeNovelPath(value: string): string {
  if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)) throw new Error("INVALID_NOVEL_PATH");
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.length < 2 || !roots.has(parts[0]!) || parts.some((part) => !part || part === "." || part === "..")) throw new Error("INVALID_NOVEL_PATH");
  if (!/\.(md|ya?ml|txt|json)$/i.test(normalized)) throw new Error("INVALID_NOVEL_FILE_TYPE");
  return normalized;
}

export function isAutonomousOpeningBundle(state: NovelState, changes: Array<z.infer<typeof patchChangeSchema>>) {
  if (state.approvalMode !== "autonomous_opening" || state.phase !== "discovery") return false;
  if (state.files["book/blueprint.md"] || state.files["book/ledger.yaml"] || state.files["book/tension-curve.yaml"]) return false;
  const allowed = /^(?:book\/(?:blueprint\.md|ledger\.yaml|tension-curve\.yaml)|book\/characters\/[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;
  if (changes.some((change) => change.operation !== "create" || !allowed.test(change.path))) return false;
  const paths = new Set(changes.map((change) => change.path));
  return paths.has("book/blueprint.md")
    && paths.has("book/ledger.yaml")
    && paths.has("book/tension-curve.yaml")
    && changes.some((change) => /^book\/characters\/.+\.md$/.test(change.path));
}

export function patchApproval(state: NovelState, changes: Array<z.infer<typeof patchChangeSchema>>): "auto" | "author" {
  if (isAutonomousOpeningBundle(state, changes)) return "auto";
  if (state.phase !== "discovery" && changes.some((change) => change.path.toLowerCase() === "book/ledger.yaml")) return "author";
  if (changes.some((change) => /^(?:book\/(?:blueprint\.md|tension-curve\.yaml)$|volumes\/volume-\d{3}-tension\.yaml$|book\/characters\/|chapters\/)/i.test(change.path))) return "author";
  return changes.some((change) => {
    const record = state.files[change.path];
    return record?.protected || record?.source === "author";
  }) ? "author" : "auto";
}

export function availableOperations(state: NovelState, activeJob?: ProductionJob): OperationAvailability {
  if (activeJob && ["queued", "running", "awaiting_author"].includes(activeJob.status)) return { allowedOperations: [], blockers: [{ code: "ACTIVE_JOB", message: "当前作品已有生产任务。" }], activeJob };
  if (state.phase === "discovery") return { allowedOperations: ["propose_blueprint", "review_project"], blockers: [] };
  if (state.phase === "completed") return { allowedOperations: ["revise_files", "review_project", "export"], blockers: [] };
  return { allowedOperations: ["write_chapters", "revise_files", "review_project", "export", "complete"], blockers: [] };
}

const unique = <T>(values: T[]) => [...new Set(values)];
export function mergeLedger(ledger: NovelLedger, chapter: number, delta: z.infer<typeof continuityDeltaSchema>): NovelLedger {
  const next = ledgerSchema.parse(structuredClone(ledger));
  for (const update of delta.characterUpdates) {
    const current = next.characters.find((item) => item.id === update.id);
    if (current) {
      if (update.name) current.name = update.name;
      if (update.role) current.role = update.role;
      if (update.goal) current.goal = update.goal;
      if (update.state) current.state = update.state;
      current.knowledge = unique([...current.knowledge, ...update.knowledge]);
      if (update.relationships.length) current.relationships = unique(update.relationships);
    } else next.characters.push({ id: update.id, name: update.name ?? update.id, role: update.role ?? "待补充", goal: update.goal ?? "待补充", state: update.state ?? "未知", knowledge: update.knowledge, relationships: update.relationships });
  }
  for (const rule of delta.worldRules) {
    const index = next.worldRules.findIndex((item) => item.id === rule.id);
    if (index >= 0) next.worldRules[index] = rule; else next.worldRules.push(rule);
  }
  for (const thread of delta.threads) {
    const current = next.openThreads.find((item) => item.id === thread.id);
    if (current) Object.assign(current, thread, { lastAdvancedChapter: chapter });
    else next.openThreads.push({ ...thread, introducedChapter: chapter, lastAdvancedChapter: chapter });
  }
  next.continuity.push({ chapter, changes: unique(delta.changes) });
  return ledgerSchema.parse(next);
}
