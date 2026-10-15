import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { AppError } from "../src/application/errors";
import {
  actualTensionCurveSchema, bookTensionCurveSchema, diagnoseTension, lockedPointChanges, markAuthorEdits, tensionCurveDependencyReasons, volumeTensionCurveSchema,
  type ActualTensionCurve, type VolumeTensionCurve,
} from "../src/domain";
import { NovelRepository } from "../src/infrastructure/novel-repository";
import { acceptedReview, chapterBasis } from "./novel-test-fixture";

const zeroHash = "0".repeat(64);
const emotion = { kind: "pressure" as const, intensity: 3 };
const point = (id: string, tension: number, extra: { progress?: number; chapter?: number; function?: "setup" | "escalation" | "turn" | "reveal" | "payoff" | "breather" | "climax" | "aftermath" } = {}) => ({ id, label: id, tension, emotion, function: extra.function ?? "escalation" as const, rationale: "用于测试相对走势", source: "ai" as const, locked: false, ...(extra.progress === undefined ? {} : { progress: extra.progress }), ...(extra.chapter === undefined ? {} : { chapter: extra.chapter }) });
const book = () => bookTensionCurveSchema.parse({ schemaVersion: 1, kind: "book", title: "全书张力", basis: { blueprintSha256: zeroHash, generatedAt: "2026-08-25T00:00:00.000Z" }, calibration: { status: "aligned", reasons: [] }, points: [point("start", 25, { progress: 0 }), point("middle", 58, { progress: 50, function: "turn" }), point("end", 92, { progress: 100, function: "climax" })] });
const volume = () => volumeTensionCurveSchema.parse({ schemaVersion: 1, kind: "volume", volume: 1, title: "第一卷", chapterRange: { from: 1, to: 5 }, basis: { blueprintSha256: zeroHash, bookCurveSha256: zeroHash, volumePlanSha256: zeroHash, generatedAt: "2026-08-25T00:00:00.000Z" }, calibration: { status: "aligned", reasons: [] }, points: [1, 2, 3, 4, 5].map((chapter) => point(`c${chapter}`, 30 + chapter * 5, { chapter })) });
const actualPoint = (chapter: number, tension: number, fn: ActualTensionCurve["points"][number]["function"] = "escalation") => ({ id: `a${chapter}`, chapter, tension, emotion, function: fn, evidence: [`第 ${chapter} 章的直接证据`], confidence: .9 });

test("tension schemas enforce book progress and complete volume chapter coverage", () => {
  assert.equal(book().points.at(-1)?.progress, 100);
  assert.equal(bookTensionCurveSchema.safeParse({ ...book(), points: [point("start", 20, { progress: 1 }), point("end", 90, { progress: 100 })] }).success, false);
  assert.equal(bookTensionCurveSchema.safeParse({ ...book(), points: [point("start", 20, { progress: 0 }), point("middle", 50, { progress: 50 }), point("back", 60, { progress: 40 }), point("end", 90, { progress: 100 })] }).success, false);
  assert.equal(volumeTensionCurveSchema.safeParse({ ...volume(), points: volume().points.filter((item) => item.chapter !== 3) }).success, false);
  assert.equal(volumeTensionCurveSchema.safeParse({ ...volume(), points: volume().points.map((item) => ({ ...item, tension: 101 })) }).success, false);
});

test("author edits become locked and ordinary AI changes cannot touch locked nodes", () => {
  const before = volume();
  const changed = volumeTensionCurveSchema.parse({ ...before, points: before.points.map((item) => item.chapter === 2 ? { ...item, tension: 73 } : item) });
  const authored = markAuthorEdits(before, changed) as VolumeTensionCurve;
  assert.deepEqual(authored.points.find((item) => item.chapter === 2), { ...changed.points[1], source: "author", locked: true });
  const overwritten = volumeTensionCurveSchema.parse({ ...authored, points: authored.points.map((item) => item.chapter === 2 ? { ...item, tension: 80 } : item) });
  assert.deepEqual(lockedPointChanges(authored, overwritten), ["c2"]);
  const unlocked = markAuthorEdits(authored, volumeTensionCurveSchema.parse({ ...authored, points: authored.points.map((item) => item.chapter === 2 ? { ...item, locked: false } : item) })) as VolumeTensionCurve;
  assert.equal(unlocked.points.find((item) => item.chapter === 2)?.locked, false);
  assert.deepEqual(tensionCurveDependencyReasons(authored, { "book/blueprint.md": "1".repeat(64), "book/tension-curve.yaml": zeroHash, "volumes/volume-001.md": zeroHash }), ["作品蓝图已变化"]);
});

test("deterministic diagnostics report flat, sustained pressure, weak climax, late payoff and deviation", () => {
  const flat = diagnoseTension([1, 2, 3, 4, 5].map((chapter) => actualPoint(chapter, 40 + chapter)));
  assert.ok(flat.some((item) => item.type === "flat"));
  assert.ok(flat.some((item) => item.type === "late_payoff"));
  const pressure = diagnoseTension([1, 2, 3, 4].map((chapter) => actualPoint(chapter, 84 + chapter)));
  assert.ok(pressure.some((item) => item.type === "sustained_pressure"));
  const weak = diagnoseTension([actualPoint(1, 72), actualPoint(2, 80, "climax")]);
  assert.ok(weak.some((item) => item.type === "weak_climax"));
  const target = volume().points;
  const deviated = diagnoseTension([actualPoint(1, 95), actualPoint(2, 90)], target);
  assert.ok(deviated.some((item) => item.type === "deviation"));
});

test("repository protects locked curve nodes and commits actual observations atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-tension-"));
  try {
    const repository = new NovelRepository(root); const state = await repository.create("张力测试");
    const ledger = "version: 1\ndecisions: []\ncharacters: []\nworldRules: []\nopenThreads: []\ncontinuity: []\n";
    const opening = await repository.prepareProposal(state.novelId, { intent: "开书", summary: "完整开书", changes: [{ operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" }, { operation: "create", path: "book/ledger.yaml", content: ledger }, { operation: "create", path: "book/tension-curve.yaml", content: stringify(book(), { lineWidth: 0 }) }] });
    await repository.approveProposal(opening);
    const plan = "# 第一卷\n\n## 第 1 章\n\n- goal: 建立压力\n- resistance: 阻碍\n- turn: 选择\n- characterShift: 改变\n- payoff: 回报\n- hook: 钩子\n";
    const shortCurve = volumeTensionCurveSchema.parse({ ...volume(), chapterRange: { from: 1, to: 1 }, points: [volume().points[0]] });
    await repository.claimProductionJob(state.novelId, "writing-job", { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 1 } }, "standard");
    const planningBasis = chapterBasis(await repository.get(state.novelId));
    shortCurve.basis.blueprintSha256 = planningBasis["book/blueprint.md"]!;
    shortCurve.basis.bookCurveSha256 = planningBasis["book/tension-curve.yaml"]!;
    await repository.commitProductionPlan(state.novelId, "writing-job", [{ operation: "create", path: "volumes/volume-001.md", content: plan }, { operation: "create", path: "volumes/volume-001-tension.yaml", content: stringify(shortCurve, { lineWidth: 0 }) }], planningBasis);
    const curveFile = await repository.readProjectFile(state.novelId, "volumes/volume-001-tension.yaml");
    await assert.rejects(() => repository.saveAuthorFile(state.novelId, curveFile.path, "points: []\n", curveFile.sha256), (error: unknown) => error instanceof AppError && error.code === "TENSION_CURVE_INVALID");
    await assert.rejects(() => repository.saveAuthorFile(state.novelId, curveFile.path, curveFile.content, zeroHash), (error: unknown) => error instanceof AppError && error.code === "FILE_STALE");
    const edited = volumeTensionCurveSchema.parse(parse(curveFile.content)); edited.points[0]!.tension = 66;
    const saved = await repository.saveAuthorFile(state.novelId, curveFile.path, stringify(edited, { lineWidth: 0 }), curveFile.sha256);
    const authored = volumeTensionCurveSchema.parse(parse(saved.content)); assert.equal(authored.points[0]!.locked, true); assert.equal(authored.points[0]!.source, "author");
    const overwritten = volumeTensionCurveSchema.parse({ ...authored, points: [{ ...authored.points[0]!, tension: 80 }] });
    await assert.rejects(() => repository.prepareProposal(state.novelId, { intent: "普通优化", summary: "修改锁定点", changes: [{ operation: "replace", path: saved.path, baseSha256: saved.sha256, content: stringify(overwritten, { lineWidth: 0 }) }] }), (error: unknown) => error instanceof AppError && error.code === "LOCKED_TENSION_NODES");
    const replacement = await repository.prepareProposal(state.novelId, { intent: "整条替换", summary: "明确覆盖锁定点", changes: [{ operation: "replace", path: saved.path, baseSha256: saved.sha256, content: stringify(overwritten, { lineWidth: 0 }), overrideLockedNodes: true }] });
    assert.equal(replacement.approval, "author");
    await repository.confirmProductionPlan(state.novelId, "writing-job");
    await repository.commitChapter(state.novelId, { jobId: "writing-job", chapter: 1, text: "# 第一章\n\n危机逼近，主角作出了不可撤回的选择。", basis: chapterBasis(await repository.get(state.novelId)), review: acceptedReview({ continuityDelta: { characterUpdates: [], worldRules: [], threads: [], changes: ["主角作出选择"] }, actualTension: { tension: 78, emotion: { kind: "pressure", intensity: 4 }, function: "turn", evidence: ["不存在于正文的证据"], confidence: .92 } }) });
    const actual = actualTensionCurveSchema.parse(parse((await repository.readProjectFile(state.novelId, "workspace/analysis/volume-001-tension-actual.yaml")).content));
    assert.equal(actual.points[0]?.tension, 78); assert.match(actual.points[0]?.evidence[0] ?? "", /未能精确定位/); assert.equal(actual.points[0]?.confidence, .35); assert.equal(actual.basis.chapterHashes["1"]?.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
