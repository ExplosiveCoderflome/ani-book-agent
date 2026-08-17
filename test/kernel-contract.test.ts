import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { skillIds } from "../src/mastra/skill-loader";
import { productionWorkflowInputSchema } from "../src/mastra/workflows/novel-production-workflow";

test("kernel exposes repository skills including generic project review", () => {
  assert.deepEqual(skillIds, ["discovery", "blueprint", "volume-planning", "chapter-writing", "critique", "project-review"]);
});

test("six deterministic tools do not call a model", async () => {
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
  assert.equal((source.match(/providerOptions: productionProviderOptions/g) ?? []).length, 5);
});
