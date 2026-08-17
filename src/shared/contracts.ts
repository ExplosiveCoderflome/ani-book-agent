import { z } from "zod";
export * from "../domain";

export const modelProfileNameSchema = z.enum(["chat", "writer", "critic"]);
export type ModelProfileName = z.infer<typeof modelProfileNameSchema>;
export const modelProfileSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), parameters: z.object({ temperature: z.number().min(0).max(2).optional(), maxOutputTokens: z.number().int().positive().optional(), topP: z.number().min(0).max(1).optional() }).default({}) });
export const modelProfilesInputSchema = z.object({ profiles: z.record(z.string(), modelProfileSchema.nullable()) });
export const modelSettingsInputSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), credentials: z.record(z.string(), z.string()).default({}) });

export interface ProviderCatalogItem { id: string; name: string; label: string; description?: string; envVar: string[]; connected: boolean; docUrl?: string; models: Array<{ id: string; name: string }> }

export const blueprintCandidateSchema = z.object({
  id: z.string(), title: z.string(), premise: z.string(), readingPromise: z.string(), protagonist: z.string(), conflict: z.string(), engine: z.string(), openingHook: z.string(), longTermDirection: z.string(), rationale: z.string(),
});
export const blueprintChoicesSchema = z.object({ choices: z.array(blueprintCandidateSchema).min(2).max(2) });
export type BlueprintCandidate = z.infer<typeof blueprintCandidateSchema>;

export const chatChoicesSchema = z.object({ choices: z.array(z.object({ label: z.string(), description: z.string(), message: z.string() })).min(2).max(5) });
export const presentChoicesSchema = z.object({
  kind: z.enum(["seed", "blueprint", "decision"]),
  choices: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), message: z.string(), details: z.record(z.string(), z.string()).optional() })).min(2).max(5),
});

export interface NovelSummary { novelId: string; title: string; phase: "discovery" | "writing" | "completed"; nextChapter: number; updatedAt: string }
export interface NovelFileView { path: string; sha256: string; version: number; source: "agent" | "author" | "imported"; protected: boolean; updatedAt: string; size: number }
export interface FileContent extends NovelFileView { content: string }
export interface ProjectSnapshot { novel: import("../domain").NovelState; availability: import("../domain").OperationAvailability; files: NovelFileView[]; activeJob?: import("../domain").ProductionJob }

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
