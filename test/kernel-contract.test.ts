import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { skillIds } from "../src/mastra/skill-loader";
import { projectTools } from "../src/mastra/tools/project-tools";
import { productionWorkflowInputSchema } from "../src/mastra/workflows/novel-production-workflow";

test("kernel exposes repository skills including generic project review", () => {
  assert.deepEqual(skillIds, ["discovery", "blueprint", "character-planning", "volume-planning", "chapter-writing", "critique", "project-review"]);
});

test("interactive agent keeps visible reasoning and replies in Simplified Chinese", async () => {
  const prompt = await readFile(new URL("../src/mastra/prompts/core.md", import.meta.url), "utf8");
  assert.match(prompt, /reasoning\/思考过程/);
  assert.match(prompt, /一律使用简体中文/);
  assert.match(prompt, /不得输出英文推理句段/);
});

test("character planning separates long-term design from committed facts", async () => {
  const [skill, blueprint] = await Promise.all([
    readFile(new URL("../src/mastra/skills/character-planning/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/skills/blueprint/SKILL.md", import.meta.url), "utf8"),
  ]);
  const workflow = await readFile(new URL("../src/mastra/workflows/novel-production-workflow.ts", import.meta.url), "utf8");
  for (const requirement of [/book\/characters\/<character-id>\.md/, /book\/ledger\.yaml/, /人物弧检查点/, /知情边界/, /同一个 `propose_patch`/]) assert.match(skill, requirement);
  for (const contract of [skill, blueprint]) {
    assert.match(contract, /relationships.*字符串数组/s);
    assert.match(contract, /(?:不得|绝不能)写成.*id.*type.*note.*对象/s);
  }
  assert.match(workflow, /角色档案（长期设计，不代表已经发生）/);
  assert.match(workflow, /readSkill\("critique"/);
});

test("discovery skill produces five serial web-fiction engines with an early payoff", async () => {
  const source = await readFile(new URL("../src/mastra/skills/discovery/SKILL.md", import.meta.url), "utf8");
  for (const engine of ["升级破局", "资源经营", "信息差博弈", "强关系对抗", "规则闯关"]) assert.match(source, new RegExp(engine));
  for (const requirement of ["一句话爆点", "核心优势", "前三章起爆", "连载循环", "稳定回报", "首次有效回报不得晚于第三章", "普通 Markdown", "恰好 5"]) assert.match(source, new RegExp(requirement));
  for (const weakPattern of ["夜色", "身世秘密", "踏上旅程", "命运齿轮开始转动"]) assert.match(source, new RegExp(weakPattern));
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
  assert.equal((source.match(/toolChoice: "none"/g) ?? []).length, 3);
  assert.equal((source.match(/providerOptions: productionProviderOptions/g) ?? []).length, 6);
  assert.match(source, /不得沿用待修稿的角色变化/);
  assert.match(source, /review\.newCharacterProfiles/);
  assert.match(source, /generatedVolumePlanSchema/);
  assert.match(source, /curve_confirmation/);
  assert.match(source, /review\.actualTension/);
});

test("reference deconstruction is a Mastra workflow with bounded parallel map reduce", async () => {
  const workflow = await readFile(new URL("../src/mastra/workflows/reference-deconstruction-workflow.ts", import.meta.url), "utf8");
  assert.match(workflow, /id: "reference-deconstruction"/);
  assert.equal((workflow.match(/foreach\([^\n]+\{ concurrency: 2 \}\)/g) ?? []).length, 4);
  for (const prompt of ["chapter", "segment", "section"]) assert.match(workflow, new RegExp(`prompt\\(\\"${prompt}\\"`));
  for (const focus of ["focus-structure", "focus-characters", "focus-pacing-hooks"]) assert.match(workflow, new RegExp(`\\"${focus}\\"`));
  assert.doesNotMatch(workflow, /vector|embedding/i);
});

test("reference sections describe the original without compliance or moralizing advice", async () => {
  const prompt = await readFile(new URL("../src/mastra/prompts/deconstruction/section.md", import.meta.url), "utf8");
  assert.match(prompt, /尊重原文/);
  assert.match(prompt, /不得淡化、改写或裁断原文/);
  assert.match(prompt, /不能写成内容管控建议/);
});

test("reference character profiles stay in an on-demand Mastra workflow", async () => {
  const [workflow, prompt] = await Promise.all([readFile(new URL("../src/mastra/workflows/reference-character-profile-workflow.ts", import.meta.url), "utf8"), readFile(new URL("../src/mastra/prompts/deconstruction/character-profile.md", import.meta.url), "utf8")]);
  assert.match(workflow, /id: "reference-character-profile"/);
  assert.match(workflow, /structuredOutputOptions\(modelSchema\)/);
  assert.match(prompt, /id: deconstruction\.character-profile/);
});

test("chapter regex suggestions stay inside the Mastra agent and a versioned structured prompt", async () => {
  const [source, prompt] = await Promise.all([
    readFile(new URL("../src/mastra/chapter-pattern-suggestion.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/prompts/deconstruction/chapter-regex.md", import.meta.url), "utf8"),
  ]);
  assert.match(source, /deconstructionAgent\.generate/);
  assert.match(source, /structuredOutputOptions\(modelSuggestionSchema\)/);
  assert.match(prompt, /id: deconstruction\.chapter-regex/);
  assert.match(prompt, /version: 2/);
});
