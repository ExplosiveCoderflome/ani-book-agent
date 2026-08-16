import assert from "node:assert/strict";
import test from "node:test";
import type { NovelState } from "../src/domain";
import { buildNovelProgress } from "../src/web/novel-progress";

function state(): NovelState {
  return {
    schemaVersion: 2,
    novelId: "progress-test",
    title: "进度测试",
    currentChapter: 13,
    approvedChapterEnd: 20,
    productionMode: "multi_volume",
    currentVolume: 2,
    volumes: {
      "1": { number: 1, startChapter: 1, endChapter: 10, final: false, status: "completed" },
      "2": { number: 2, startChapter: 11, endChapter: 20, final: true, status: "active" },
    },
    productionStatus: "in_progress",
    artifacts: { "volume:1:handoff": { status: "ready", path: "volumes/volume-01-handoff.md", protected: false } },
    continuity: { lastCommittedChapter: 12, revision: 12 },
  };
}

test("novel progress reports stable chapters and per-volume completion", () => {
  const progress = buildNovelProgress(state());
  assert.equal(progress.stableChapters, 12);
  assert.deepEqual(progress.volumes.map(({ number, completedChapters, percent, phase }) => ({ number, completedChapters, percent, phase })), [
    { number: 1, completedChapters: 10, percent: 100, phase: "handoff_ready" },
    { number: 2, completedChapters: 2, percent: 20, phase: "active" },
  ]);
  assert.equal(progress.focusVolume.number, 2);
});

test("novel progress exposes a blocked final audit without marking completion", () => {
  const novel = state();
  novel.volumes["2"] = { ...novel.volumes["2"]!, status: "completed" };
  novel.currentChapter = 21;
  novel.continuity = { lastCommittedChapter: 20, revision: 20 };
  novel.productionStatus = "awaiting_completion_review";
  novel.completionAudit = { verdict: "block", summary: "仍有伏笔", qualityDebt: [], missingChapters: [], unresolvedPromises: ["旧案真相"], continuityAnomalies: [] };
  const progress = buildNovelProgress(novel);
  assert.equal(progress.focusVolume.phase, "audit_blocked");
  assert.equal(progress.focusVolume.percent, 100);
});

test("novel progress adds the unconfigured next volume as a planning step", () => {
  const novel = state();
  delete novel.volumes["2"];
  novel.currentChapter = 11;
  novel.continuity = { lastCommittedChapter: 10, revision: 10 };
  const progress = buildNovelProgress(novel);
  assert.equal(progress.volumes.at(-1)?.phase, "planning");
  assert.equal(progress.volumes.at(-1)?.number, 2);
  assert.equal(progress.focusVolume.number, 2);
  assert.equal(progress.focusVolume.phase, "planning");
});
