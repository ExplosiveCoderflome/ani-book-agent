import { NovelRepository } from "../infrastructure/novel-repository";
import type { NovelState } from "../domain";
import { AppError } from "./errors";

/** Content only: leaves room for instructions, schemas, and model output. */
export const CONTEXT_CONTENT_BUDGET = 12_000;

type ContextPart = { key: string; content: string; allocation: number; tail: boolean };

function priorityFor(key: string) {
  if (key.endsWith(":chapter_plan")) return 8;
  if (key.endsWith(":continuity_update") || key.endsWith(":humanization_revision")) return 7;
  if (key === "book:volume_outline" || /^volume:\d+:outline$/.test(key)) return 5;
  if (/^volume:\d+:handoff$/.test(key)) return 6;
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
  return renderContext(state.title, state.openingChoices, items);
}

/** Assemble only available evidence for audit workflows; missing keys remain visible in the header. */
export async function assembleAvailableNovelContext(repository: NovelRepository, novelId: string, keys: string[]) {
  const state = await repository.get(novelId);
  const ready = keys.filter((key) => state.artifacts[key]?.status === "ready");
  const items = await Promise.all(ready.map(async (key) => ({ key, content: (await repository.readArtifact(novelId, key)).content })));
  const missing = keys.filter((key) => !ready.includes(key));
  return `${missing.length ? `声明依赖中尚未就绪的工件（不得当作已完成）：${missing.join(", ")}` : "声明依赖均已就绪。"}\n\n${renderContext(state.title, state.openingChoices, items)}`;
}

function renderContext(title: string, openingChoices: NovelState["openingChoices"], items: Array<{ key: string; content: string }>) {
  const sections = [`作品：${title}`, `开书选择：${JSON.stringify(openingChoices ?? {})}`, "以下为按任务优先级压缩的权威上下文；每项均来自声明依赖。"];
  for (const part of planContextParts(items)) {
    const excerpt = part.tail ? part.content.slice(-part.allocation) : part.content.slice(0, part.allocation);
    sections.push(`\n## ${part.key}\n[已传入 ${excerpt.length}/${part.content.length} 字符${part.tail ? "，保留末尾连续性" : ""}]\n${excerpt}`);
  }
  return sections.join("\n");
}
