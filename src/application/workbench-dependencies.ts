import type {
  ErrorSanitizer,
  InteractiveNovelPort,
  MarketRadarRunner,
  MarketRadarStore,
  ModelSettingsPort,
  NovelProductionRunner,
  NovelProjectStore,
  PreferencesStore,
  SkillCatalogPort,
} from "./ports";
import type { ReferenceAdaptationService } from "./reference-adaptation-service";

export type WorkbenchDependencies = {
  novels: NovelProjectStore;
  models: ModelSettingsPort;
  skills: SkillCatalogPort;
  preferences: PreferencesStore;
  market: MarketRadarStore;
  production: NovelProductionRunner;
  marketRefresh: MarketRadarRunner;
  marketSummary: MarketRadarRunner;
  interactive: InteractiveNovelPort;
  adaptations: ReferenceAdaptationService;
  providerCatalog(configured: Set<string>): Promise<any[]>;
  sanitizeError: ErrorSanitizer;
};
