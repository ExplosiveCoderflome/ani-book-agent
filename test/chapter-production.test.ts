import assert from "node:assert/strict";
import test from "node:test";
import { chapterOverlapRatio, characterAssetPaths, extractChapterPlan } from "../src/mastra/workflows/novel-production-workflow";

test("character assets are separate files under the character folder", () => {
  assert.deepEqual(characterAssetPaths(["book/characters.md", "book/characters/villain.md", "book/blueprint.md", "book/characters/hero.md"]), ["book/characters/hero.md", "book/characters/villain.md"]);
});

test("writer receives only the requested chapter card", () => {
  const plan = "# 卷计划\n\n## 第一章《归乡》\n目标：找到断剑。\n\n## 第二章《地窖》\n目标：躲进地窖。\n\n## 第 3 章：开炉\n目标：第一次开炉。";
  assert.equal(extractChapterPlan(plan, 2), "## 第二章《地窖》\n目标：躲进地窖。");
  assert.equal(extractChapterPlan(plan, 3), "## 第 3 章：开炉\n目标：第一次开炉。");
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
