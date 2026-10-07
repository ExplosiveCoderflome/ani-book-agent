import { createMarketService } from "./market-service";
import { createNovelService } from "./novel-service";
import { createSettingsService } from "./settings-service";
import { createSkillTestingService } from "./skill-testing-service";
import type { WorkbenchDependencies } from "./workbench-dependencies";

export function createWorkbenchService(deps: WorkbenchDependencies) {
  return {
    ...createSettingsService(deps),
    ...createNovelService(deps),
    ...createMarketService(deps),
    ...createSkillTestingService(deps),
  };
}

export type WorkbenchService = ReturnType<typeof createWorkbenchService>;
