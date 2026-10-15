import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { skillIds } from "../src/mastra/skill-loader";
import { projectToolIds, selectProjectReadPaths } from "../src/mastra/tools/project-tools";
import { productionWorkflowInputSchema } from "../src/mastra/workflows/novel-production-workflow";
import { executionEnvelopeSchema, executionStage } from "../src/domain";

test("kernel exposes repository skills including generic project review", () => {
  assert.deepEqual(skillIds, ["discovery", "blueprint", "character-planning", "volume-planning", "chapter-writing", "critique", "project-review"]);
});

test("interactive agent keeps visible reasoning and replies in Simplified Chinese", async () => {
  const prompt = await readFile(new URL("../src/mastra/prompts/core.md", import.meta.url), "utf8");
  assert.match(prompt, /reasoning\/思考过程/);
  assert.match(prompt, /一律使用简体中文/);
  assert.match(prompt, /不得输出英文推理句段/);
});

test("interactive chapter requests start the committing workflow instead of previewing prose", async () => {
  const [prompt, tools] = await Promise.all([
    readFile(new URL("../src/mastra/prompts/core.md", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/tools/project-tools.ts", import.meta.url), "utf8"),
  ]);
  assert.match(prompt, /要求写第一章、生成正文、续写尚未存在的章节时，必须调用 `start_job`/);
  assert.match(prompt, /不得生成或预览整章正文/);
  assert.match(prompt, /不得询问“是否正式写入”/);
  assert.match(prompt, /直接提交到 `chapters\/chapter-NNN\.md`/);
  assert.match(tools, /write_chapters 会在自动写作、验收和有限修复通过后直接提交章节与连续性/);
});

test("character planning separates long-term design from committed facts", async () => {
  const [skill, blueprint] = await Promise.all([
    readFile(new URL("../src/mastra/skills/character-planning/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/skills/blueprint/SKILL.md", import.meta.url), "utf8"),
  ]);
  const workflow = await readFile(new URL("../src/mastra/workflows/novel-production-workflow.ts", import.meta.url), "utf8");
  for (const requirement of [/book\/characters\/<character-id>\.md/, /book\/ledger\.yaml/, /人物弧检查点/, /知情边界/, /外貌与辨识特征/, /不得留空或写“待确认”/, /同一个 `propose_patch`/]) assert.match(skill, requirement);
  assert.match(blueprint, /外貌与辨识特征/);
  for (const contract of [skill, blueprint]) {
    assert.match(contract, /relationships.*字符串数组/s);
    assert.match(contract, /(?:不得|绝不能)写成.*id.*type.*note.*对象/s);
  }
  assert.match(workflow, /角色档案（长期设计，不代表已经发生）/);
  assert.match(workflow, /readSkill\("critique"/);
});

test("discovery skill calibrates preferences before three serial web-fiction candidates", async () => {
  const source = await readFile(new URL("../src/mastra/skills/discovery/SKILL.md", import.meta.url), "utf8");
  for (const engine of ["升级破局", "资源经营", "信息差博弈", "强关系对抗", "规则闯关"]) assert.match(source, new RegExp(engine));
  for (const requirement of ["一句话爆点", "核心优势", "前三章起爆", "连载循环", "稳定回报", "首次有效回报不得晚于第三章", "普通 Markdown", "恰好 3", "两个高匹配方向"]) assert.match(source, new RegExp(requirement));
  for (const weakPattern of ["夜色", "身世秘密", "踏上旅程", "命运齿轮开始转动"]) assert.match(source, new RegExp(weakPattern));
});

test("six deterministic tools do not call a model", async () => {
  assert.deepEqual(projectToolIds, ["read_project", "search_project", "read_skill", "read_reference", "propose_patch", "start_job"]);
  const source = await readFile(new URL("../src/mastra/tools/project-tools.ts", import.meta.url), "utf8");
  assert.equal((source.match(/createTool\(\{/g) ?? []).length, 6);
  assert.doesNotMatch(source, /\.generate\(|\.stream\(|generateWithGuard/);
});

test("project reads use the current file manifest instead of guessing directories", async () => {
  assert.deepEqual(selectProjectReadPaths([
    { path: "book", offset: 0, maxChars: 12_000 },
    { path: "workspace/ideas.md", offset: 0, maxChars: 12_000 },
    { path: "book/blueprint.md", offset: 0, maxChars: 12_000 },
  ], ["workspace/ideas.md"]), {
    readable: [{ path: "workspace/ideas.md", offset: 0, maxChars: 12_000 }],
    skipped: [
      { path: "book", reason: "路径不在当前文件清单中；目录和尚未创建的文件不能读取。" },
      { path: "book/blueprint.md", reason: "路径不在当前文件清单中；目录和尚未创建的文件不能读取。" },
    ],
  });
  const [prompt, blueprint] = await Promise.all([
    readFile(new URL("../src/mastra/prompts/core.md", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/skills/blueprint/SKILL.md", import.meta.url), "utf8"),
  ]);
  assert.match(prompt, /paths: \[\]/);
  assert.match(prompt, /不要读取尚不存在的 `book` 文件/);
  assert.match(blueprint, /不要读取 `book` 目录/);
});

test("production workflow has one public job contract", () => {
  const parsed = productionWorkflowInputSchema.parse({ novelId: "11111111-1111-4111-8111-111111111111", jobId: "job", goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 }, baseStateHash: "a".repeat(64) });
  assert.equal(parsed.scope.toChapter, 3);
  const review = productionWorkflowInputSchema.parse({ novelId: parsed.novelId, jobId: "review", goal: "review_project", scope: { fromChapter: 1, toChapter: 5 }, brief: "检查连续性和人物知情边界", baseStateHash: parsed.baseStateHash });
  assert.equal(review.brief, "检查连续性和人物知情边界");
  assert.equal(productionWorkflowInputSchema.safeParse({ ...parsed, goal: "legacy-workflow" }).success, false);
});

test("production harness envelope pins authoritative execution context", () => {
  const envelope = executionEnvelopeSchema.parse({ schemaVersion: 1, runId: "run-1", traceId: "run-1", novelId: "11111111-1111-4111-8111-111111111111", taskType: "write_chapters", stage: executionStage("write_chapters"), novelStateHash: "a".repeat(64), preferenceVersion: 3, skillVersions: { "chapter-writing": "v1" }, allowedTools: [], requiresApproval: true, contextBudget: 32_000 });
  assert.equal(envelope.stage, "planning");
  assert.equal(envelope.preferenceVersion, 3);
  assert.equal(productionWorkflowInputSchema.parse({ novelId: envelope.novelId, jobId: envelope.runId, goal: envelope.taskType, scope: {}, baseStateHash: envelope.novelStateHash, execution: envelope }).execution?.traceId, "run-1");
  assert.equal(executionEnvelopeSchema.safeParse({ ...envelope, novelStateHash: "stale" }).success, false);
});

test("author preference memory cannot drift a running production prompt", async () => {
  const source = await readFile(new URL("../src/mastra/agents/novel-agent.ts", import.meta.url), "utf8");
  assert.match(source, /requestContext\.get\("taskType"\) === "chat" \? await deps\.preferences\.prompt/);
});

test("production prose calls cannot drift into the interactive tool loop", async () => {
  const [source, agents, composition] = await Promise.all([
    readFile(new URL("../src/mastra/workflows/novel-production-workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/agents/novel-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mastra/composition.ts", import.meta.url), "utf8"),
  ]);
  assert.equal((source.match(/toolChoice: "none"/g) ?? []).length, 3);
  assert.equal((source.match(/providerOptions: productionProviderOptions/g) ?? []).length, 3);
  assert.match(source, /generateValidatedStructure/);
  assert.match(source, /custom: \{ reasoningEffort: "none"/);
  assert.match(source, /MAX_CHAPTER_QUALITY_REWRITES/);
  assert.match(source, /inputData\.interactionMode === "standard" && !resumeData/);
  assert.match(source, /generatedVolumePlanSchema/);
  assert.doesNotMatch(source, /planning\?\.created && !resumeData/);
  assert.match(source, /await repository\.commitChapter/);
  assert.match(source, /text, review, basis: context\.basis/);
  const writer = agents.slice(agents.indexOf("const novelWriter"), agents.indexOf("const novelCritic"));
  assert.match(writer, /id: "novel-writer"/);
  assert.doesNotMatch(writer, /tools:|workspace:|new Memory/);
  assert.match(composition, /novelAgent: novelWriter, novelCritic/);
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
