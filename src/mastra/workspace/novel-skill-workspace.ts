import { CompositeVersionedSkillSource, Workspace } from "@mastra/core/workspace";
import { skillRegistry } from "../../application/skill-service";
import { mastraStorage } from "../runtime-storage";

export async function createNovelSkillWorkspace(requestContext: { get(key: string): unknown }, agentId: "novel-agent" | "novel-critic") {
  const novelId = requestContext.get("novelId");
  if (typeof novelId !== "string") return undefined;
  const taskType = requestContext.get("taskType");
  const entries = await skillRegistry.workspaceEntries(novelId, agentId, typeof taskType === "string" ? taskType : undefined);
  if (!entries.length) return undefined;
  return new Workspace({
    id: "novel-skills-" + novelId + "-" + agentId,
    name: "小说创作 Skill",
    skills: ["/"],
    skillSource: new CompositeVersionedSkillSource(entries, mastraStorage.stores!.blobs!),
    bm25: { tokenize: { minLength: 1, removePunctuation: true } },
  });
}

