import { randomUUID } from "node:crypto";
import { createReferenceAdaptationService } from "../application/reference-adaptation-service";
import { createReferenceService } from "../application/reference-service";
import { createWorkbenchService } from "../application/workbench-service";
import type { NovelAgentStore, NovelWorkflowStore } from "../application/ports";
import { AuthorPreferenceRepository } from "../infrastructure/author-preference-repository";
import { matchChapterPatterns } from "../infrastructure/chapter-pattern-matcher";
import { MarketRadarRepository } from "../infrastructure/market-radar-repository";
import { ModelSettingsStore, sanitizeProviderError } from "../infrastructure/model-settings";
import { NovelRepository } from "../infrastructure/novel-repository";
import { loadProviderCatalog } from "../infrastructure/provider-catalog";
import { estimateDeconstruction, referenceChaptersInRange, ReferenceRepository } from "../infrastructure/reference-repository";
import { SkillRegistryService } from "../infrastructure/skill-registry";
import { createAdaptationPlanner } from "./adaptation-planner";
import { createDeconstructionAgent } from "./agents/deconstruction-agent";
import { createMarketRadarAgent } from "./agents/market-radar-agent";
import { createNovelAgents } from "./agents/novel-agent";
import { createChapterPatternAdvisor } from "./chapter-pattern-suggestion";
import { createInteractiveNovelAdapter } from "./interactive-novel-adapter";
import { mastraStorage } from "./runtime-storage";
import { DeferredAdaptationPlanner, DeferredChapterPatternAdvisor, DeferredInteractiveNovel, DeferredWorkflowRunner } from "./runtime-adapters";
import { bindSkillCatalog, loadCorePrompt, readSkill } from "./skill-loader";
import { createProjectTools } from "./tools/project-tools";
import { createWorkbenchApiRoutes } from "./workbench-api";
import { createMarketRadarSummaryWorkflow } from "./workflows/market-radar-summary-workflow";
import { createMarketRadarWorkflow } from "./workflows/market-radar-workflow";
import { createNovelProductionWorkflow } from "./workflows/novel-production-workflow";
import { createReferenceCharacterProfileWorkflow } from "./workflows/reference-character-profile-workflow";
import { createReferenceDeconstructionWorkflow, DECONSTRUCTION_PROMPT_VERSION } from "./workflows/reference-deconstruction-workflow";
import { createNovelSkillWorkspaceFactory } from "./workspace/novel-skill-workspace";

let composed: ReturnType<typeof compose> | undefined;

function compose() {
  const novels = new NovelRepository(); const references = new ReferenceRepository(); const models = new ModelSettingsStore();
  const preferences = new AuthorPreferenceRepository(); const market = new MarketRadarRepository();
  const skills = new SkillRegistryService(novels, mastraStorage.stores!.skills!, mastraStorage.stores!.blobs!);
  const agentNovels: NovelAgentStore = {
    get: novels.get.bind(novels), listFiles: novels.listFiles.bind(novels), readProjectFile: novels.readProjectFile.bind(novels),
    search: novels.search.bind(novels), prepareProposal: novels.prepareProposal.bind(novels), applyProposal: novels.applyProposal.bind(novels),
  };
  const productionNovels: NovelWorkflowStore = {
    get: novels.get.bind(novels), listFiles: novels.listFiles.bind(novels), readProjectFile: novels.readProjectFile.bind(novels),
    stateHash: novels.stateHash.bind(novels), adaptations: novels.adaptations.bind(novels), activeAdaptations: novels.activeAdaptations.bind(novels),
    commitProductionPlan: novels.commitProductionPlan.bind(novels), commitChapter: novels.commitChapter.bind(novels),
    commitReviewReport: novels.commitReviewReport.bind(novels), exportNovel: novels.exportNovel.bind(novels), finishProductionJob: novels.finishProductionJob.bind(novels),
  };
  bindSkillCatalog(skills);
  const productionRunner = new DeferredWorkflowRunner("小说生产工作流"); const referenceRunner = new DeferredWorkflowRunner("拆书工作流");
  const characterRunner = new DeferredWorkflowRunner("角色档案工作流"); const marketRunner = new DeferredWorkflowRunner("市场雷达工作流");
  const marketSummaryRunner = new DeferredWorkflowRunner("市场总结工作流"); const planner = new DeferredAdaptationPlanner();
  const chapterPattern = new DeferredChapterPatternAdvisor(); const interactive = new DeferredInteractiveNovel();
  const adaptations = createReferenceAdaptationService({ novels, references, planner, newId: randomUUID });
  const workbench = createWorkbenchService({ novels, models, skills, preferences, market, production: productionRunner, marketRefresh: marketRunner, marketSummary: marketSummaryRunner, interactive, adaptations, providerCatalog: loadProviderCatalog, sanitizeError: sanitizeProviderError });
  const referenceService = createReferenceService({ references, models, deconstruction: referenceRunner, characters: characterRunner, chapterPattern, estimator: { estimate: estimateDeconstruction, chapters: referenceChaptersInRange }, sanitizeError: sanitizeProviderError, promptVersion: DECONSTRUCTION_PROMPT_VERSION, newId: randomUUID });
  const projectTools = createProjectTools({ novels: agentNovels, references, skills, readSkill, startProductionJob: workbench.startProductionJob });
  const workspace = createNovelSkillWorkspaceFactory(skills, mastraStorage.stores!.blobs!);
  const { novelAgent, novelWriter, novelCritic } = createNovelAgents({ models, novels: { get: agentNovels.get }, preferences, projectTools, loadCorePrompt, readSkill, workspace });
  const deconstructionAgent = createDeconstructionAgent(models); const marketRadarAgent = createMarketRadarAgent(models);
  planner.bind(createAdaptationPlanner(novelWriter)); chapterPattern.bind(createChapterPatternAdvisor(models, deconstructionAgent, matchChapterPatterns)); interactive.bind(createInteractiveNovelAdapter(novelAgent, models, sanitizeProviderError));
  const novelProductionWorkflow = createNovelProductionWorkflow({ novels: productionNovels, models, novelAgent: novelWriter, novelCritic });
  const referenceDeconstructionWorkflow = createReferenceDeconstructionWorkflow({ references, models, deconstructionAgent, estimator: { estimate: estimateDeconstruction, chapters: referenceChaptersInRange } });
  const referenceCharacterProfileWorkflow = createReferenceCharacterProfileWorkflow({ references, models, deconstructionAgent });
  const marketRadarWorkflow = createMarketRadarWorkflow(market); const marketRadarSummaryWorkflow = createMarketRadarSummaryWorkflow({ market, marketRadarAgent });
  productionRunner.bind(novelProductionWorkflow); referenceRunner.bind(referenceDeconstructionWorkflow); characterRunner.bind(referenceCharacterProfileWorkflow); marketRunner.bind(marketRadarWorkflow); marketSummaryRunner.bind(marketRadarSummaryWorkflow);
  productionRunner.assertBound(); referenceRunner.assertBound(); characterRunner.assertBound(); marketRunner.assertBound(); marketSummaryRunner.assertBound(); planner.assertBound(); chapterPattern.assertBound(); interactive.assertBound();
  const apiRoutes = createWorkbenchApiRoutes({ workbench, references: referenceService, adaptations, skills, models });
  return { storage: mastraStorage, apiRoutes, workbench, references: referenceService, adaptations, skills, agents: { novelAgent, novelWriter, novelCritic, deconstructionAgent, marketRadarAgent }, workflows: { novelProductionWorkflow, referenceDeconstructionWorkflow, referenceCharacterProfileWorkflow, marketRadarWorkflow, marketRadarSummaryWorkflow }, repositories: { novels, references, preferences, market, models } };
}

export function createComposition() { return composed ??= compose(); }
