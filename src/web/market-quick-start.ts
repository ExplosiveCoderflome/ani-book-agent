import type { MarketRadarSummary } from "../shared/contracts";

export type MarketQuickStartSeed = {
  id: string;
  label: string;
  mode: "guided" | "autonomous_opening";
  prompt: string;
};

type QuickStartStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const quickStartStoragePrefix = "ani-novel-market-quick-start:";
const quickStartAttemptedStoragePrefix = "ani-novel-market-quick-start-attempted:";

function browserStorage(): QuickStartStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

function isQuickStartSeed(value: unknown): value is MarketQuickStartSeed {
  if (!value || typeof value !== "object") return false;
  const seed = value as Partial<MarketQuickStartSeed>;
  return typeof seed.id === "string" && typeof seed.label === "string" && typeof seed.prompt === "string" && (seed.mode === "guided" || seed.mode === "autonomous_opening");
}

export function persistMarketQuickStart(novelId: string, seed: MarketQuickStartSeed, storage = browserStorage()) {
  try {
    storage?.setItem(`${quickStartStoragePrefix}${novelId}`, JSON.stringify(seed));
    storage?.removeItem(`${quickStartAttemptedStoragePrefix}${novelId}`);
  } catch { /* Recovery remains available from the novel state. */ }
}

export function readMarketQuickStart(novelId: string, storage = browserStorage()): MarketQuickStartSeed | undefined {
  try {
    const raw = storage?.getItem(`${quickStartStoragePrefix}${novelId}`);
    if (!raw) return undefined;
    const seed: unknown = JSON.parse(raw);
    return isQuickStartSeed(seed) ? seed : undefined;
  } catch { return undefined; }
}

export function clearMarketQuickStart(novelId: string, storage = browserStorage()) {
  try {
    storage?.removeItem(`${quickStartStoragePrefix}${novelId}`);
    storage?.removeItem(`${quickStartAttemptedStoragePrefix}${novelId}`);
  } catch { /* A stale seed is still guarded by authoritative project state. */ }
}

export function markMarketQuickStartAttempted(novelId: string, storage = browserStorage()) {
  try { storage?.setItem(`${quickStartAttemptedStoragePrefix}${novelId}`, "1"); } catch { /* The in-memory command guard still prevents duplicate sends in this page. */ }
}

export function wasMarketQuickStartAttempted(novelId: string, storage = browserStorage()) {
  try { return storage?.getItem(`${quickStartAttemptedStoragePrefix}${novelId}`) === "1"; } catch { return false; }
}

export const autonomousOpeningRecoveryGoal = "继续完成当前作品尚未完成的全自动开书：先读取权威作品状态，不要重复已经创建的文件、已应用提案或已启动任务；补齐作品蓝图、连续性账本、全书张力曲线和核心角色档案后，从权威 nextChapter 继续生成至第 3 章，完成后停止。";

const autonomousInstruction = [
  "这是一次全自动开书授权。请先读取当前作品状态，在内部生成并比较候选方向，直接选择最适合中文网文连载的原创方案，不要向我展示候选或等待确认。",
  "随后一次性创建完整开书资产：作品蓝图、连续性账本、全书张力曲线和核心角色档案；全部通过校验后立即启动现有章节生产任务，生成第 1—3 章。",
  "不得模仿或复制榜单作品的专有名字、设定、情节组合或表达。除非任务失败或我主动停止，否则中途不要请求确认；完成第三章后停止，不要继续生成第四章。",
].join("\n\n");

const guidedInstruction = "请直接进入开书构思，给我三个差异明显的原创故事种子。每个种子都要包含一句话 premise、主角卖点、核心冲突和前三章兑现。现在不要创建蓝图或正文，等我选择。";

export function quickStartFromGenre(genre: MarketRadarSummary["genres"][number], mode: MarketQuickStartSeed["mode"] = "guided"): MarketQuickStartSeed {
  return {
    id: `genre:${genre.name}`,
    label: genre.name,
    mode,
    prompt: [
      `我想以“${genre.name}”为主要题材快速开书。`,
      `市场题材观察：${genre.observation}`,
      `公开榜单信号：${genre.evidence.join("、")}。`,
      "这些信号只用于确认题材方向，不代表成功保证；不要模仿或复制榜单作品的专有名字、设定、情节组合或表达。",
      mode === "autonomous_opening" ? autonomousInstruction : guidedInstruction,
    ].join("\n\n"),
  };
}

export function quickStartFromFeelCard(card: MarketRadarSummary["feelCards"][number], mode: MarketQuickStartSeed["mode"] = "guided"): MarketQuickStartSeed {
  return {
    id: `feel:${card.id}`,
    label: card.label,
    mode,
    prompt: [
      card.prompt,
      `这次快速开书来自“${card.label}”感觉卡：${card.reason}`,
      "把它当作题材与阅读感觉信号，不要模仿或复制榜单作品的专有名字、设定、情节组合或表达。",
      mode === "autonomous_opening" ? autonomousInstruction : guidedInstruction,
    ].join("\n\n"),
  };
}

export function quickStartTitle(seed: MarketQuickStartSeed) {
  return `未命名 · ${seed.label}`.slice(0, 80);
}
