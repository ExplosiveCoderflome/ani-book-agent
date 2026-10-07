import assert from "node:assert/strict";
import test from "node:test";
import { chapterJobBrief, chapterOverlapRatio, chapterPlanCoversRange, chapterQualityAction, characterAssetPaths, extractChapterPlan, MAX_CHAPTER_QUALITY_REWRITES, productionWorkflowInputSchema, volumePlanningGaps } from "../src/mastra/workflows/novel-production-workflow";

test("character assets are separate files under the character folder", () => {
  assert.deepEqual(characterAssetPaths(["book/characters.md", "book/characters/villain.md", "book/blueprint.md", "book/characters/hero.md"]), ["book/characters/hero.md", "book/characters/villain.md"]);
});

test("writer receives only the requested chapter card", () => {
  const plan = "# 卷计划\n\n## 第一章《归乡》\n目标：找到断剑。\n\n## 第二章《地窖》\n目标：躲进地窖。\n\n## 第 3 章：开炉\n目标：第一次开炉。";
  assert.equal(extractChapterPlan(plan, 2), "## 第二章《地窖》\n目标：躲进地窖。");
  assert.equal(extractChapterPlan(plan, 3), "## 第 3 章：开炉\n目标：第一次开炉。");
  assert.equal(chapterPlanCoversRange(plan, 1, 3), true);
  assert.equal(chapterPlanCoversRange(plan, 1, 4), false);
  assert.throws(() => extractChapterPlan(plan, 4), /缺少第 4 章章节卡/);
  assert.deepEqual(volumePlanningGaps(plan, [1, 2, 3].map((chapter) => ({ chapter })), 4, 6), {
    missingPlanChapters: [4, 5, 6], missingCurveChapters: [4, 5, 6],
  });
});

test("the current production brief overrides variable details in the stored chapter card", () => {
  assert.match(chapterJobBrief("  结尾改为王爷独白，正文约 3000–4000 字。  "), /作者本次任务要求/);
  assert.match(chapterJobBrief("  结尾改为王爷独白，正文约 3000–4000 字。  "), /以本段为准/);
  assert.match(chapterJobBrief("  结尾改为王爷独白，正文约 3000–4000 字。  "), /结尾改为王爷独白/);
  assert.equal(chapterJobBrief(undefined), "");
});

test("cross-chapter guard catches a copied previous chapter despite punctuation changes", () => {
  const previous = `第七年,他回来了。${"村里人没有认出他，他走进废弃炉坊。".repeat(30)}`;
  const candidate = `第七年，他回来了！${"村里人没有认出他；他走进废弃炉坊。".repeat(30)}随后他躲进地窖。`;
  assert.ok(chapterOverlapRatio(previous, candidate) > 0.95);
});

test("cross-chapter guard accepts a genuinely continued chapter", () => {
  const previous = `第七年,他回来了。${"村里人没有认出他，他走进废弃炉坊。".repeat(30)}`;
  const candidate = `火把已经照到断墙外。${"陆还抱着断剑钻进地窖，摸到了师父留下的炭字。".repeat(30)}`;
  assert.equal(chapterOverlapRatio(previous, candidate), 0);
});

test("production workflow defaults to the standard first attempt and preserves retry metadata", () => {
  const base = { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 }, novelId: "9f44f1a5-75dd-428e-99cc-a18f3548601f", jobId: "job-1", baseStateHash: "a".repeat(64) };
  const standard = productionWorkflowInputSchema.parse(base);
  assert.equal(standard.interactionMode, "standard");
  assert.equal(standard.attempt, 1);
  assert.equal(standard.retryOf, undefined);

  const retry = productionWorkflowInputSchema.parse({ ...base, jobId: "job-2", interactionMode: "autonomous_opening", retryOf: "job-1", attempt: 2 });
  assert.equal(retry.interactionMode, "autonomous_opening");
  assert.equal(retry.retryOf, "job-1");
  assert.equal(retry.attempt, 2);
});

test("every chapter mode accepts only an approved draft and stops after two quality rewrites", () => {
  assert.equal(MAX_CHAPTER_QUALITY_REWRITES, 2);
  assert.equal(chapterQualityAction("accepted", 0), "accept");
  assert.equal(chapterQualityAction("repair", 0), "rewrite");
  assert.equal(chapterQualityAction("replan", 1), "rewrite");
  assert.equal(chapterQualityAction("repair", 2), "fail");
  assert.equal(chapterQualityAction("replan", 2), "fail");
});
