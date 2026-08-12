import { NovelRepository } from "../infrastructure/novel-repository";
import { AppError } from "./errors";

/** Content only: leaves room for instructions, schemas, and model output. */
export const CONTEXT_CONTENT_BUDGET = 12_000;

type ContextPart = { key: string; content: string; allocation: number; tail: boolean };

function priorityFor(key: string) {
  if (key.endsWith(":chapter_plan")) return 8;
  if (key.endsWith(":continuity_update") || key.endsWith(":humanization_revision")) return 7;
  if (key === "book:volume_outline") return 5;
  if (key === "book:character_cast" || key === "book:world_bible") return 4;
  if (key === "book:novel_brief" || key === "book:story_bible" || key === "book:volume_strategy") return 2;
  return 3;
}

function usesTail(key: string) { return key.endsWith(":continuity_update") || key.endsWith(":humanization_revision"); }

/** Allocate a bounded context without silently dropping declared dependencies. */
export function planContextParts(items: Array<{ key: string; content: string }>, budget = CONTEXT_CONTENT_BUDGET): ContextPart[] {
  if (!items.length) return [];
  const minimum = Math.min(600, Math.floor(budget / items.length));
  const remaining = Math.max(0, budget - minimum * items.length);
  const weight = items.reduce((total, item) => total + priorityFor(item.key), 0);
  let assigned = 0;
  return items.map((item, index) => {
    const extra = index === items.length - 1 ? remaining - assigned : Math.floor(remaining * priorityFor(item.key) / weight);
    assigned += extra;
    return { key: item.key, content: item.content, allocation: minimum + extra, tail: usesTail(item.key) };
  });
}

export async function assembleNovelContext(repository: NovelRepository, novelId: string, keys: string[]) {
  const state = await repository.get(novelId);
  const items = await Promise.all(keys.map(async (key) => {
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status !== "ready") throw new AppError("DEPENDENCY_NOT_READY", `上游工件 ${key} 尚未就绪。`, 409, true);
    return { key, content: (await repository.readArtifact(novelId, key)).content };
  }));
  const sections = [`作品：${state.title}`, `开书选择：${JSON.stringify(state.openingChoices ?? {})}`, "以下为按任务优先级压缩的权威上下文；每项均来自声明依赖。"];
  for (const part of planContextParts(items)) {
    const excerpt = part.tail ? part.content.slice(-part.allocation) : part.content.slice(0, part.allocation);
    sections.push(`\n## ${part.key}\n[已传入 ${excerpt.length}/${part.content.length} 字符${part.tail ? "，保留末尾连续性" : ""}]\n${excerpt}`);
  }
  return sections.join("\n");
}
