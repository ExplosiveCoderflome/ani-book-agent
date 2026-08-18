import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { skillIds } from "../src/mastra/skill-loader";
import { projectTools } from "../src/mastra/tools/project-tools";
import { productionWorkflowInputSchema } from "../src/mastra/workflows/novel-production-workflow";

test("kernel exposes repository skills including generic project review", () => {
  assert.deepEqual(skillIds, ["discovery", "blueprint", "character-planning", "volume-planning", "chapter-writing", "critique", "project-review"]);
});

test("character planning separates long-term design from committed facts", async () => {
  const skill = await readFile(new URL("../src/mastra/skills/character-planning/SKILL.md", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../src/mastra/workflows/novel-production-workflow.ts", import.meta.url), "utf8");
  for (const requirement of [/book\/characters\/<character-id>\.md/, /book\/ledger\.yaml/, /人物弧检查点/, /知情边界/, /同一个 `propose_patch`/]) assert.match(skill, requirement);
  assert.match(workflow, /角色档案（长期设计，不代表已经发生）/);
  assert.match(workflow, /readSkill\("critique"/);
});

test("discovery skill defines five distinct actionable seed contracts", async () => {
  const source = await readFile(new URL("../src/mastra/skills/discovery/SKILL.md", import.meta.url), "utf8");
  for (const angle of ["爽点强钩子", "人物成长线", "设定奇观线", "关系牵引线", "悬念追查线"]) assert.match(source, new RegExp(angle));
  for (const requirement of ["核心变量", "连载引擎", "阅读回报", "普通 Markdown", "恰好 5"]) assert.match(source, new RegExp(requirement));
});

test("six deterministic tools do not call a model", async () => {
  assert.deepEqual(Object.keys(projectTools), ["read_project", "search_project", "read_skill", "read_reference", "propose_patch", "start_job"]);
  const source = await readFile(new URL("../src/mastra/tools/project-tools.ts", import.meta.url), "utf8");
  assert.equal((source.match(/createTool\(\{/g) ?? []).length, 6);
  assert.doesNotMatch(source, /\.generate\(|\.stream\(|generateWithGuard/);
});

test("production workflow has one public job contract", () => {
  const parsed = productionWorkflowInputSchema.parse({ novelId: "11111111-1111-4111-8111-111111111111", jobId: "job", goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 }, baseStateHash: "a".repeat(64) });
  assert.equal(parsed.scope.toChapter, 3);
  const review = productionWorkflowInputSchema.parse({ novelId: parsed.novelId, jobId: "review", goal: "review_project", scope: { fromChapter: 1, toChapter: 5 }, brief: "检查连续性和人物知情边界", baseStateHash: parsed.baseStateHash });
  assert.equal(review.brief, "检查连续性和人物知情边界");
  assert.equal(productionWorkflowInputSchema.safeParse({ ...parsed, goal: "legacy-workflow" }).success, false);
});

test("production prose calls cannot drift into the interactive tool loop", async () => {
  const source = await readFile(new URL("../src/mastra/workflows/novel-production-workflow.ts", import.meta.url), "utf8");
  assert.equal((source.match(/toolChoice: "none"/g) ?? []).length, 2);
  assert.equal((source.match(/providerOptions: productionProviderOptions/g) ?? []).length, 5);
  assert.match(source, /不得沿用待修稿的角色变化/);
  assert.match(source, /review\.newCharacterProfiles/);
});

test("reference deconstruction is a Mastra workflow with bounded parallel map reduce", async () => {
  const workflow = await readFile(new URL("../src/mastra/workflows/reference-deconstruction-workflow.ts", import.meta.url), "utf8");
  assert.match(workflow, /id: "reference-deconstruction"/);
  assert.equal((workflow.match(/foreach\([^\n]+\{ concurrency: 2 \}\)/g) ?? []).length, 4);
  for (const prompt of ["chapter", "segment", "book", "verify"]) assert.match(workflow, new RegExp(`prompt\\(\\"${prompt}\\"`));
  for (const focus of ["focus-structure", "focus-characters", "focus-pacing-hooks"]) assert.match(workflow, new RegExp(`\\"${focus}\\"`));
  assert.doesNotMatch(workflow, /vector|embedding/i);
});
