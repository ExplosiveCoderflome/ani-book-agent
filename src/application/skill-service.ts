import type { SkillFile } from "../domain";
import type { SkillCatalogPort } from "./ports";

export type SkillDraftInput = {
  expectedVersionId?: string;
  name: string;
  description: string;
  files: SkillFile[];
  compatibleAgents: string[];
  taskTypes: string[];
  requiresSandbox: boolean;
  changeMessage?: string;
};

export type SkillRegistryService = SkillCatalogPort;
