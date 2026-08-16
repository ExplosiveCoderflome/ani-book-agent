import assert from "node:assert/strict";
import test from "node:test";
import { builtinAgentProfiles, builtinSkills, defaultProjectRecipe, resolvePlatformCatalog } from "../src/application/platform-catalog";
import { openingSeedsSchema } from "../src/shared/contracts";

test("platform catalog resolves bounded built-in skills without a second runtime", () => {
  const recipe = defaultProjectRecipe("auto");
  const resolved = resolvePlatformCatalog(recipe);
  assert.equal(recipe.chapterBatchSize, 5);
  assert.equal(resolved.skills.length, builtinSkills.length);
  assert.equal(resolved.agents.length, builtinAgentProfiles.length);
  assert.ok(resolved.skills.every((skill) => skill.prompt.length > 0));
});

test("no-idea opening contract requires exactly five seeds", () => {
  const seed = { label: "种子", description: "差异", message: "请沿这个方向继续" };
  assert.equal(openingSeedsSchema.safeParse({ choices: Array.from({ length: 5 }, () => seed) }).success, true);
  assert.equal(openingSeedsSchema.safeParse({ choices: Array.from({ length: 4 }, () => seed) }).success, false);
});
