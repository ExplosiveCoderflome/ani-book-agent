import { stringify } from "yaml";
import type { CriticResult, NovelState, PatchProposal } from "../src/domain";
import { NovelRepository } from "../src/infrastructure/novel-repository";

const zeroHash = "0".repeat(64);
const generatedAt = "2026-08-25T00:00:00.000Z";
const emotion = { kind: "pressure", intensity: 3 };
export const emptyLedger = "version: 1\ndecisions: []\ncharacters: []\nworldRules: []\nopenThreads: []\ncontinuity: []\n";
export const openingChanges = (): PatchProposal["changes"] => [
  { operation: "create", path: "book/blueprint.md", content: "# 蓝图\n主角必须查清城中的异变。\n" },
  { operation: "create", path: "book/ledger.yaml", content: emptyLedger },
  { operation: "create", path: "book/tension-curve.yaml", content: stringify({ schemaVersion: 1, kind: "book", title: "全书张力", basis: { blueprintSha256: zeroHash, generatedAt }, calibration: { status: "aligned", reasons: [] }, points: [
    { id: "opening", progress: 0, label: "开篇", tension: 30, emotion, function: "hook", rationale: "建立问题", source: "ai", locked: false },
    { id: "ending", progress: 100, label: "终局", tension: 92, emotion, function: "climax", rationale: "完成兑现", source: "ai", locked: false },
  ] }) },
];

export const planningChanges = (toChapter = 3, state?: NovelState): PatchProposal["changes"] => [
  { operation: "create", path: "volumes/volume-001.md", content: "# 第一卷\n\n" + Array.from({ length: toChapter }, (_, i) => `## 第 ${i + 1} 章\n\n- goal: 查清线索\n- resistance: 守门人阻拦\n- turn: 付出代价\n- characterShift: 决定信任同伴\n- payoff: 发现证据\n- hook: 新的疑问\n`).join("\n") },
  { operation: "create", path: "volumes/volume-001-tension.yaml", content: stringify({ schemaVersion: 1, kind: "volume", volume: 1, title: "第一卷", chapterRange: { from: 1, to: toChapter }, basis: { blueprintSha256: state?.files["book/blueprint.md"]?.sha256 ?? zeroHash, bookCurveSha256: state?.files["book/tension-curve.yaml"]?.sha256 ?? zeroHash, volumePlanSha256: zeroHash, generatedAt }, calibration: { status: "aligned", reasons: [] }, points: Array.from({ length: toChapter }, (_, i) => ({ id: `c${i + 1}`, chapter: i + 1, label: `第 ${i + 1} 章`, tension: 30 + i * 5, emotion, function: "escalation", rationale: "提高代价", source: "ai", locked: false })) }) },
];

export function acceptedReview(overrides: Partial<CriticResult> = {}): CriticResult {
  return { verdict: "accepted", summary: "符合章节计划", issues: [], continuityDelta: { characterUpdates: [], worldRules: [], threads: [], changes: [] }, newCharacterProfiles: [], actualTension: { tension: 40, emotion: { kind: "pressure", intensity: 3 }, function: "escalation", evidence: ["主角发现证据"], confidence: .9 }, ...overrides };
}

export function chapterBasis(state: NovelState): Record<string, string> {
  const prefix = `volumes/volume-${String(state.currentVolume).padStart(3, "0")}`;
  return Object.fromEntries(["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml", `${prefix}.md`, `${prefix}-tension.yaml`].filter((file) => state.files[file]).map((file) => [file, state.files[file]!.sha256]));
}

export async function prepareWriting(repository: NovelRepository, novelId: string, jobId = "writing-job", toChapter = 3) {
  if ((await repository.get(novelId)).phase === "discovery") {
    const opening = await repository.prepareProposal(novelId, { intent: "开书", summary: "确认开书资产", changes: openingChanges() });
    await repository.approveProposal(opening);
  }
  await repository.claimProductionJob(novelId, jobId, { goal: "write_chapters", scope: { fromChapter: 1, toChapter } }, "standard");
  const state = await repository.get(novelId);
  if (!state.files["volumes/volume-001.md"]) await repository.commitProductionPlan(novelId, jobId, planningChanges(toChapter, state), chapterBasis(state));
  await repository.confirmProductionPlan(novelId, jobId);
  return { jobId, basis: chapterBasis(await repository.get(novelId)) };
}
