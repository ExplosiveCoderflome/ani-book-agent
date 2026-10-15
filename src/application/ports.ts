import type {
  AdaptationPlan, ApprovalMode, ChapterManifest, ChapterParserConfig, ChapterPatternSuggestion, ChapterRange, CriticResult, DeconstructionFocus,
  DeconstructionMode, FileContent, MarketRadarSnapshot, MarketRadarSummary, NovelFileView, NovelLedger, NovelState, NovelSummary,
  PatchProposal, PreferenceSignalInput, ProductionInteractionMode, ProductionJobRequest, ReferenceAdaptation, ReferenceAnalysis, ReferenceAnalysisPreset,
  ReferenceCharacterProfile, ReferenceSection, ReferenceState, ReferenceStructureRadar, SkillBindings, SkillSandboxCapabilities,
  SkillVersion, TokenEstimate,
} from "../domain";

export type RuntimeRunState = {
  status: string; resourceId?: string; payload?: unknown; result?: unknown; error?: { message?: string };
  steps?: Record<string, unknown>; createdAt?: string; updatedAt?: string;
};
type StoredFileRecord = Omit<NovelFileView, "path" | "size">;
export type RuntimeRun = {
  runId: string;
  start(input: { inputData: unknown }): Promise<unknown>;
  resume(input: { step: string; resumeData: unknown }): Promise<{ status: string }>;
  cancel(): Promise<unknown>;
};
export interface WorkflowRunnerPort {
  createRun(input?: { runId?: string; resourceId?: string }): Promise<RuntimeRun>;
  getWorkflowRunById(runId: string, options?: unknown): Promise<RuntimeRunState | null | undefined>;
}
export interface NovelProductionRunner extends WorkflowRunnerPort {}
export interface ReferenceAnalysisRunner extends WorkflowRunnerPort {}
export interface CharacterProfileRunner extends WorkflowRunnerPort {}
export interface MarketRadarRunner extends WorkflowRunnerPort {}

export interface NovelProjectStore {
  create(title: string, approvalMode?: ApprovalMode): Promise<NovelState>;
  get(novelId: string): Promise<NovelState>;
  list(): Promise<NovelSummary[]>;
  listFiles(novelId: string): Promise<NovelFileView[]>;
  readProjectFile(novelId: string, relativePath: string, offset?: number, maxChars?: number): Promise<FileContent>;
  search(novelId: string, query: string, limit?: number): Promise<Array<{ path: string; excerpt: string }>>;
  prepareProposal(novelId: string, input: { intent: string; summary: string; changes: PatchProposal["changes"] }): Promise<PatchProposal>;
  applyProposal(raw: PatchProposal): Promise<{ proposal: PatchProposal; state: NovelState; duplicate: boolean }>;
  approveProposal(raw: PatchProposal): Promise<{ proposal: PatchProposal; state: NovelState; duplicate: boolean }>;
  rejectProposal(raw: PatchProposal): Promise<PatchProposal>;
  saveAuthorFile(novelId: string, relativePath: string, content: string, expectedSha256: string): Promise<FileContent>;
  readLedger(novelId: string): Promise<NovelLedger>;
  commitProductionPlan(novelId: string, jobId: string, changes: PatchProposal["changes"], basis: Record<string, string>): Promise<NovelState>;
  confirmProductionPlan(novelId: string, jobId: string): Promise<NovelState>;
  commitChapter(novelId: string, input: ChapterCommitInput): Promise<{ state: NovelState; path: string; sha256: string }>;
  commitReviewReport(novelId: string, jobId: string, report: string, basis: Record<string, string>): Promise<{ path: string }>;
  claimProductionJob(novelId: string, jobId: string, request: ProductionJobRequest, interactionMode: ProductionInteractionMode, options?: ProductionClaimOptions): Promise<NovelState>;
  finishProductionJob(novelId: string, jobId: string, outcome: "completed" | "failed" | "canceled"): Promise<NovelState>;
  cancelAutonomousOpening(novelId: string): Promise<NovelState>;
  exportNovel(novelId: string, jobId: string): Promise<{ path: string }>;
  stateHash(state: NovelState): string;
  adaptationAuthorityFiles(state: NovelState): Record<string, string>;
  adaptationSetHash(versions: Record<string, string>): string;
  saveAdaptation(adaptation: ReferenceAdaptation): Promise<{ adaptation: ReferenceAdaptation; file: StoredFileRecord }>;
  adaptations(novelId: string): Promise<Array<{ adaptation: ReferenceAdaptation; file: FileContent }>>;
  updateAdaptation(novelId: string, adaptationId: string, action: "approve" | "reject"): Promise<{ adaptation: ReferenceAdaptation; file: StoredFileRecord }>;
  markAdaptationStale(novelId: string, adaptationId: string, reasons: ReferenceAdaptation["staleReasons"]): Promise<{ adaptation: ReferenceAdaptation; file: StoredFileRecord } | { adaptation: ReferenceAdaptation; file: FileContent }>;
  activeAdaptations(novelId: string, chapter: number): Promise<Array<{ adaptation: ReferenceAdaptation; file: FileContent }>>;
}

export type ChapterCommitInput = { jobId: string; chapter: number; text: string; review: CriticResult; basis: Record<string, string> };
export type ProductionClaimOptions = { expectedStateHash?: string; previousJob?: { id: string; status: "failed" | "completed" | "canceled" } };

// Adapters receive only the commands their role is allowed to issue. Author
// decisions never enter the Agent tool or production Workflow capability.
export type NovelAgentStore = Pick<NovelProjectStore, "get" | "listFiles" | "readProjectFile" | "search" | "prepareProposal" | "applyProposal">;
export type NovelWorkflowStore = Pick<NovelProjectStore,
  "get" | "listFiles" | "readProjectFile" | "stateHash" | "adaptations" | "activeAdaptations"
  | "commitProductionPlan" | "commitChapter" | "commitReviewReport" | "exportNovel" | "finishProductionJob"
>;

export interface ReferenceLibraryStore {
  libraryState(): Promise<{ activeJobId?: string; activeReferenceId?: string }>;
  claimJob(referenceId: string, jobId: string, analysis: ReferenceAnalysis): Promise<ReferenceState>;
  assertActiveJob(referenceId: string, jobId: string): Promise<void>;
  clearActiveJob(referenceId: string, jobId: string): Promise<boolean>;
  finishJob(referenceId: string, jobId: string, analysisId: string, result: ReferenceJobCompletion): Promise<boolean>;
  import(input: { fileName: string; title?: string; bytes: Buffer }): Promise<unknown>;
  list(): Promise<ReferenceState[]>;
  get(id: string): Promise<ReferenceState>;
  manifest(id: string): Promise<ChapterManifest>;
  parser(id: string): Promise<ChapterParserConfig>;
  source(id: string): Promise<string>;
  sourceSlice(id: string, start: number, end: number): Promise<{ start: number; end: number; content: string }>;
  rebuildManifest(id: string): Promise<unknown>;
  saveParser(id: string, input: unknown): Promise<ChapterParserConfig>;
  confirmManifest(id: string, expectedHash: string): Promise<unknown>;
  delete(id: string): Promise<void>;
  clearAnalyses(id: string): Promise<ReferenceState>;
  updateAnalysis(id: string, analysis: ReferenceAnalysis, jobId?: string): Promise<ReferenceState>;
  propagateStale(id: string, sourceHash: string, manifestHash: string, promptVersion: string): Promise<ReferenceState>;
  writeAnalysisFile(id: string, analysisId: string, relative: string, content: string, jobId?: string): Promise<string>;
  readAnalysisFile(id: string, analysisId: string, relative: string, maxChars?: number): Promise<string>;
  listAnalysisFiles(id: string, analysisId: string, directory: "batches" | "segments" | "chapters" | "focus"): Promise<string[]>;
  section(id: string, analysisId: string, key: string): Promise<ReferenceSection>;
  sections(id: string, analysisId: string): Promise<ReferenceSection[]>;
  character(id: string, analysisId: string, name: string): Promise<ReferenceCharacterProfile>;
  radar(id: string, analysisId: string): Promise<ReferenceStructureRadar>;
  analysisHash(id: string, analysisId: string): Promise<string>;
}

export type ReferenceJobCompletion = { status: "completed" | "failed" | "canceled" } & Partial<Pick<ReferenceAnalysis, "inputTokens" | "outputTokens" | "usageEstimated" | "reportPath" | "radarPath">>;

export interface ModelSettingsPort {
  status(): Promise<any>;
  profiles(): Promise<any>;
  save(providerId: string, modelId: string, credentials: Record<string, string>, baseURL?: string): Promise<any>;
  saveProfiles(input: unknown): Promise<any>;
  fetchCustomModels(input: { baseURL: string; apiKey: string }): Promise<any>;
  runtimeSelection(profile: "chat" | "writer" | "critic" | "analysis"): Promise<any>;
}
export interface ModelSettingsStore extends ModelSettingsPort {}

export interface PreferencesStore {
  get(): Promise<{ version: number }>;
  record(input: PreferenceSignalInput): Promise<unknown>;
  prompt(novelId: string): Promise<string>;
}

export interface MarketRadarStore {
  get(capturedAt?: string): Promise<MarketRadarSnapshot | undefined>;
  history(): Promise<Array<{ capturedAt: string; itemCount: number }>>;
  getSummary(capturedAt?: string): Promise<MarketRadarSummary | undefined>;
  saveSummary(summary: MarketRadarSummary): Promise<void>;
  refresh(): Promise<MarketRadarSnapshot>;
}

export interface SkillCatalogPort {
  list(status?: "draft" | "published" | "archived"): Promise<any[]>;
  create(input: unknown, origin?: string): Promise<any>;
  reloadBuiltins(): Promise<any>;
  importGit(input: any): Promise<any>;
  importArchive(base64: string): Promise<any>;
  get(skillId: string, includeDraft?: boolean): Promise<any>;
  versions(skillId: string): Promise<any[]>;
  version(skillId: string, versionId?: string): Promise<SkillVersion>;
  derive(skillId: string): Promise<any>;
  saveDraft(skillId: string, input: unknown): Promise<any>;
  validate(skillId: string): Promise<any>;
  publish(skillId: string, expectedVersionId?: string): Promise<any>;
  rollback(skillId: string, versionId: string): Promise<any>;
  archive(skillId: string): Promise<any>;
  bindings(novelId: string): Promise<SkillBindings>;
  saveBindings(novelId: string, bindings: SkillBindings, expectedSha256: string): Promise<FileContent>;
  resolveForAgent(novelId: string, agentId: string, taskType?: string): Promise<Array<{ skillId: string; versionId: string; name: string; description: string }>>;
  workspaceEntries(novelId: string, agentId: string, taskType?: string): Promise<any[]>;
  sandboxCapabilities(): SkillSandboxCapabilities;
}
export interface SkillCatalogStore extends SkillCatalogPort {}

export interface CreativeAgentPort {
  generate(prompt: string, options?: any): Promise<any>;
  getMemory?(): Promise<any>;
}
export interface CreativeAgentRunner extends CreativeAgentPort {}

export interface ConversationMemoryPort {
  recall(novelId: string): Promise<any[]>;
}

export interface InteractiveNovelPort extends ConversationMemoryPort {
  testConnection(): Promise<{ ok: true; latencyMs: number; model: string }>;
  testSkill(prompt: string): Promise<{ output: string; elapsedMs: number; traceId?: string }>;
}

export interface AdaptationPlannerPort {
  plan(input: {
    novel: { title: string; nextChapter: number; blueprint: string; ledger: string };
    scope: { fromChapter: number; toChapter: number };
    insights: Array<{ id: string; title: string; mechanism: string; fitFor: string[]; doNotCopy: string[]; adaptationHint: string }>;
  }): Promise<AdaptationPlan>;
}

export interface ChapterPatternAdvisorPort { suggest(sample: unknown): Promise<ChapterPatternSuggestion> }
export interface ReferenceEstimatorPort {
  estimate(manifest: ChapterManifest, mode: DeconstructionMode, focuses: DeconstructionFocus[], chapterRange?: ChapterRange, preset?: ReferenceAnalysisPreset): TokenEstimate;
  chapters(manifest: ChapterManifest, chapterRange?: ChapterRange): ChapterManifest["chapters"];
}

export type ErrorSanitizer = (error: unknown) => string;
