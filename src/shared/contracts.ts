import { z } from "zod";
export * from "../domain";

export const modelProfileNameSchema = z.enum(["chat", "writer", "critic", "analysis"]);
export type ModelProfileName = z.infer<typeof modelProfileNameSchema>;
export const modelProfileSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), parameters: z.object({ temperature: z.number().min(0).max(2).optional(), maxOutputTokens: z.number().int().positive().optional(), topP: z.number().min(0).max(1).optional() }).default({}) });
export const modelProfilesInputSchema = z.object({ profiles: z.record(z.string(), modelProfileSchema.nullable()) });
export const modelSettingsInputSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), credentials: z.record(z.string(), z.string()).default({}) });

export interface ProviderCatalogItem { id: string; name: string; label: string; description?: string; envVar: string[]; connected: boolean; docUrl?: string; models: Array<{ id: string; name: string }> }

export interface NovelSummary { novelId: string; title: string; phase: "discovery" | "writing" | "completed"; nextChapter: number; updatedAt: string }
export interface NovelFileView { path: string; sha256: string; version: number; source: "agent" | "author" | "imported"; protected: boolean; updatedAt: string; size: number }
export interface FileContent extends NovelFileView { content: string }
export interface ProjectSnapshot { novel: import("../domain").NovelState; availability: import("../domain").OperationAvailability; files: NovelFileView[]; characterStates: import("../domain").NovelLedger["characters"]; activeJob?: import("../domain").ProductionJob }
export interface ReferenceDetailView { state: import("../domain").ReferenceState; manifest: import("../domain").ChapterManifest; estimate: import("../domain").TokenEstimate; activeJob?: import("../domain").ReferenceJob }
export interface ReferenceAnalysisView { analysis: import("../domain").ReferenceAnalysis; report?: string; index?: { chapterCount: number; segmentCount: number; inputTokens: number; outputTokens: number; usageEstimated: boolean } }

export type SkillRecordView = import("../domain").SkillRecord;
export type SkillVersionView = import("../domain").SkillVersion;
export type SkillFileView = import("../domain").SkillFile;
export type SkillBindingsView = import("../domain").SkillBindings;
export type SkillValidationView = import("../domain").SkillValidationResult;
export type SkillSandboxView = import("../domain").SkillSandboxCapabilities;
export interface SkillDraftView {
  expectedVersionId?: string;
  name: string;
  description: string;
  files: import("../domain").SkillFile[];
  compatibleAgents: string[];
  taskTypes: string[];
  requiresSandbox: boolean;
  changeMessage?: string;
}
