import assert from "node:assert/strict";
import test from "node:test";
import { chunkReviewSources, renderProjectReviewReport, selectReviewPaths, validateProjectReviewEvidence } from "../src/mastra/workflows/novel-production-workflow";

test("generic review scope selects explicit files, chapter ranges, or the whole creative project", () => {
  const files = ["book/blueprint.md", "book/ledger.yaml", "chapters/chapter-001.md", "chapters/chapter-002.md", "workspace/ideas.md", "workspace/reviews/old.md", "exports/book.txt"];
  assert.deepEqual(selectReviewPaths(files, { paths: ["book/ledger.yaml"] }), ["book/ledger.yaml"]);
  assert.deepEqual(selectReviewPaths(files, { fromChapter: 2, toChapter: 2 }), ["chapters/chapter-002.md"]);
  assert.deepEqual(selectReviewPaths(files, {}), ["book/blueprint.md", "book/ledger.yaml", "chapters/chapter-001.md", "chapters/chapter-002.md", "workspace/ideas.md"]);
});

test("generic review discards evidence that is not present in the claimed file", () => {
  const validated = validateProjectReviewEvidence({ summary: "审查完成", strengths: [], findings: [{ severity: "high", category: "连续性", title: "道具错位", evidence: [{ path: "chapters/chapter-001.md", excerpt: "真实段落" }, { path: "chapters/chapter-002.md", excerpt: "不存在的段落" }], explanation: "道具来源冲突", recommendation: "修复顺序" }] }, [{ path: "chapters/chapter-001.md", content: "这里包含真实段落。" }, { path: "chapters/chapter-002.md", content: "另一章内容。" }]);
  assert.deepEqual(validated.findings[0]?.evidence, [{ path: "chapters/chapter-001.md", excerpt: "真实段落" }]);
  assert.equal(validated.summary, "审查完成");
  const rejected = validateProjectReviewEvidence({ ...validated, findings: [{ ...validated.findings[0]!, evidence: [{ path: "chapters/chapter-002.md", excerpt: "仍然不存在" }] }] }, [{ path: "chapters/chapter-002.md", content: "另一章内容。" }]);
  assert.match(rejected.summary, /保留 0 项/);
});

test("generic review batches bounded context and renders an evidence report", () => {
  const batches = chunkReviewSources([{ path: "chapters/chapter-001.md", content: "甲".repeat(20) }, { path: "chapters/chapter-002.md", content: "乙".repeat(20) }], 30);
  assert.equal(batches.length, 2);
  const report = renderProjectReviewReport("检查连续性", ["chapters/chapter-001.md"], [{ summary: "发现一处冲突", strengths: [], findings: [{ severity: "high", category: "连续性", title: "道具提前出现", evidence: [{ path: "chapters/chapter-001.md", excerpt: "尚未取得钥匙" }], explanation: "正文状态冲突", recommendation: "调整取得钥匙的事件顺序" }] }]);
  assert.match(report, /项目审查报告/);
  assert.match(report, /chapters\/chapter-001\.md/);
  assert.match(report, /道具提前出现/);
});
