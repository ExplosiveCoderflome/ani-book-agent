import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REFERENCE_DIMENSIONS,
  REFERENCE_DIMENSION_SYSTEMS,
  buildReferenceStructureRadar,
  referenceAnalysisSchema,
  referenceStructureRadarSchema,
  transitionAdaptation,
  type ReferenceAdaptation,
  type ReferenceDimensionObservation,
} from "../src/domain";
import { createReferenceAdaptationService } from "../src/application/reference-adaptation-service";
import type { NovelProjectStore, ReferenceLibraryStore } from "../src/application/ports";

const novelId = "11111111-1111-4111-8111-111111111111";
const referenceId = "22222222-2222-4222-8222-222222222222";
const adaptationId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-08-31T00:00:00.000Z";
const evidence = { chapterId: "chapter-0001", excerpt: "主角每次取胜都会失去一项资源。", start: 0, end: 18 };
const insight = {
  id: "cost-escalation",
  title: "胜利成本递增",
  mechanism: "每次阶段兑现都附带更高成本。",
  fitFor: ["升级线"],
  doNotCopy: ["原作角色和事件组合"],
  adaptationHint: "将成本换成目标小说既有资源与关系。",
  evidence: [evidence],
};

const observation = (dimensionId: ReferenceDimensionObservation["dimensionId"], score: number, confidence: number): ReferenceDimensionObservation => ({
  dimensionId,
  score,
  confidence,
  summary: `${dimensionId} 的证据结论`,
  transferableMechanism: `${dimensionId} 的可迁移机制`,
  evidence: [evidence],
  insightId: insight.id,
});

test("reference dimension registry contains seven systems and 70 stable dimensions", () => {
  assert.equal(REFERENCE_DIMENSION_SYSTEMS.length, 7);
  assert.deepEqual(REFERENCE_DIMENSION_SYSTEMS.map((item) => item.to - item.from + 1), [12, 10, 15, 10, 11, 8, 4]);
  assert.equal(REFERENCE_DIMENSIONS.length, 70);
  assert.deepEqual(REFERENCE_DIMENSIONS.map(([id]) => id), Array.from({ length: 70 }, (_, index) => String(index + 1).padStart(2, "0")));
  assert.equal(new Set(REFERENCE_DIMENSIONS.map(([id]) => id)).size, 70);
});

test("structure radar keeps sparse observations, separates coverage, and confidence-weights scores", () => {
  const radar = buildReferenceStructureRadar([
    observation("01", 4, 1),
    observation("02", 2, .5),
    observation("01", 1, .2),
  ], [insight.id, "other", insight.id], timestamp);
  const character = radar.systems.find((item) => item.systemId === "character")!;
  const geography = radar.systems.find((item) => item.systemId === "geography")!;
  assert.equal(radar.observations.length, 2, "the higher-confidence duplicate wins");
  assert.equal(character.score, 67);
  assert.equal(character.coverage, 2 / 12);
  assert.equal(geography.score, null);
  assert.equal(geography.coverage, 0);
  assert.deepEqual(radar.recommendedInsightIds, [insight.id, "other"]);
  assert.equal(referenceStructureRadarSchema.safeParse({ ...radar, recommendedInsightIds: ["1", "2", "3", "4"] }).success, false);
});

test("legacy reference analysis remains valid without a radar path", () => {
  const parsed = referenceAnalysisSchema.parse({
    id: "legacy",
    mode: "standard",
    focuses: [],
    status: "completed",
    sourceHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    promptVersion: "4",
    tokenBudget: 100_000,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  assert.equal(parsed.radarPath, undefined);
});

test("adaptation creation strips evidence, defaults to three chapters, and requires a separate approval", async () => {
  let stored: ReferenceAdaptation | undefined;
  let authority = { "book/blueprint.md": "a".repeat(64), "book/ledger.yaml": "b".repeat(64) };
  let plannerInput: any;
  const novels = {
    get: async () => ({ novelId, title: "目标小说", nextChapter: 8 }),
    readProjectFile: async (_id: string, path: string) => ({ path, content: path.endsWith("yaml") ? "version: 1" : "# 蓝图", sha256: "c".repeat(64) }),
    stateHash: () => "d".repeat(64),
    adaptationAuthorityFiles: () => authority,
    saveAdaptation: async (adaptation: ReferenceAdaptation) => { stored = adaptation; return { adaptation, file: { sha256: "e".repeat(64) } }; },
    adaptations: async () => stored ? [{ adaptation: stored, file: { sha256: "e".repeat(64) } }] : [],
    updateAdaptation: async (_id: string, _adaptationId: string, action: "approve" | "reject") => {
      stored = transitionAdaptation(stored!, action, timestamp);
      return { adaptation: stored, file: { sha256: "f".repeat(64) } };
    },
    markAdaptationStale: async (_id: string, _adaptationId: string, reasons: ReferenceAdaptation["staleReasons"]) => {
      stored = { ...stored!, status: "stale", staleReasons: reasons, updatedAt: timestamp };
      return { adaptation: stored, file: { sha256: "f".repeat(64) } };
    },
  } as unknown as NovelProjectStore;
  const references = {
    get: async () => ({ analyses: [{ id: "analysis-1", status: "completed", stale: false }] }),
    radar: async () => buildReferenceStructureRadar([observation("33", 5, .9)], [insight.id], timestamp),
    sections: async () => [{ insights: [insight] }],
    analysisHash: async () => "9".repeat(64),
  } as unknown as ReferenceLibraryStore;
  const service = createReferenceAdaptationService({
    novels,
    references,
    newId: () => adaptationId,
    now: () => timestamp,
    planner: { plan: async (input) => { plannerInput = input; return { summary: "用成本递增强化三章小弧线。", constraints: { planning: ["每章提高代价"], writing: ["只使用目标小说既有人物"], review: ["检查表层复制风险"] } }; } },
  });
  const created = await service.create(referenceId, "analysis-1", { novelId, selectedInsightIds: [insight.id] });
  assert.equal(created.adaptation.status, "proposed");
  assert.deepEqual(created.adaptation.scope, { fromChapter: 8, toChapter: 10 });
  assert.equal("evidence" in plannerInput.insights[0], false);
  assert.equal("evidence" in created.adaptation.selectedInsights[0]!, false);
  assert.deepEqual(Object.keys(service).sort(), ["action", "create", "list"], "approval does not start production");
  const approved = await service.action(novelId, adaptationId, "approve");
  assert.equal(approved.adaptation.status, "approved");
  authority = { "book/ledger.yaml": "b".repeat(64), "book/blueprint.md": "a".repeat(64) };
  assert.equal((await service.list(novelId))[0]?.adaptation.status, "approved", "key order alone is not stale");
  authority = { ...authority, "book/blueprint.md": "0".repeat(64) };
  const stale = await service.list(novelId);
  assert.equal(stale[0]?.adaptation.status, "stale");
  assert.deepEqual(stale[0]?.adaptation.staleReasons, ["authority"]);
  await assert.rejects(() => service.action(novelId, adaptationId, "approve"), /作品规划或拆书结果已经变化/);
});

test("chapter production only injects approved in-range mechanism constraints", async () => {
  const [workflow, repository] = await Promise.all([
    readFile(new URL("../src/mastra/workflows/novel-production-workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/infrastructure/novel-repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workflow, /repository\.activeAdaptations\(novelId, chapter\)/);
  assert.match(repository, /adaptation\.status === "approved" && adaptation\.scope\.fromChapter <= chapter && adaptation\.scope\.toChapter >= chapter/);
  assert.match(workflow, /selectedInsights\.map\(\(\{ id, title, mechanism, adaptationHint, doNotCopy \}\)/);
  assert.doesNotMatch(workflow, /insight\.evidence/);
  assert.match(workflow, /assertAdaptationVersions/);
  assert.match(workflow, /这些内容不包含参考作品原文/);
  assert.match(workflow, /不得复制专有名字、设定组合、情节组合或句式/);
});
