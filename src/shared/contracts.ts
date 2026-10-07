import { z } from "zod";
export { MAX_REFERENCE_TOKEN_BUDGET, MIN_REFERENCE_TOKEN_BUDGET, patchProposalSchema, referenceAnalysisFieldLabels } from "../domain";
export type {
  ChapterParserConfig, ChapterPattern, ChapterPatternSuggestion, ChapterRange, DeconstructionFocus, DeconstructionMode, FileContent,
  MarketRadarRun, MarketRadarSnapshot, MarketRadarSummary, NovelFileView, NovelSummary, PatchProposal, ProductionJob, ProductionJobRequest,
  ProjectSnapshot, ReferenceAdaptation, ReferenceAnalysisPreset, ReferenceCharacterProfile, ReferenceJob, ReferenceSection, ReferenceState,
  ReferenceStructureRadar, TokenEstimate,
} from "../domain";

export const modelProfileNameSchema = z.enum(["chat", "writer", "critic", "analysis"]);
export type ModelProfileName = z.infer<typeof modelProfileNameSchema>;
export const modelProfileSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), parameters: z.object({ temperature: z.number().min(0).max(2).optional(), maxOutputTokens: z.number().int().positive().optional(), topP: z.number().min(0).max(1).optional() }).default({}) });
export const modelProfilesInputSchema = z.object({ profiles: z.record(z.string(), modelProfileSchema.nullable()) });
export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_API_KEY = "CUSTOM_API_KEY";
export const modelBaseUrlSchema = z.string().trim().url("请输入有效的 API 地址").refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "API 地址须使用 HTTP 或 HTTPS，且不能包含密钥、查询参数或片段").transform((value) => value.replace(/\/+$/, ""));
export const customModelsInputSchema = z.object({ baseURL: modelBaseUrlSchema, apiKey: z.string().trim().default("") });
export const modelSettingsInputSchema = z.object({
  providerId: z.string().trim().min(1), modelId: z.string().trim().min(1, "请输入模型名称"),
  baseURL: modelBaseUrlSchema.optional(), credentials: z.record(z.string(), z.string()).default({}),
}).refine((value) => value.providerId !== CUSTOM_PROVIDER_ID || Boolean(value.baseURL), { path: ["baseURL"], message: "请填写第三方 API 地址" });

export interface ProviderCatalogItem { id: string; name: string; label: string; description?: string; envVar: string[]; connected: boolean; docUrl?: string; models: Array<{ id: string; name: string }> }

export interface ReferenceDetailView { state: import("../domain").ReferenceState; manifest: import("../domain").ChapterManifest; parser: import("../domain").ChapterParserConfig; estimate: import("../domain").TokenEstimate; activeJob?: import("../domain").ReferenceJob }
export interface ReferenceAnalysisView { analysis: import("../domain").ReferenceAnalysis; sections: import("../domain").ReferenceSection[]; radar?: import("../domain").ReferenceStructureRadar; index?: { chapterCount: number; chapterRange?: import("../domain").ChapterRange; segmentCount: number; inputTokens: number; outputTokens: number; usageEstimated: boolean } }

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
