import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MIN_REFERENCE_TOKEN_BUDGET,
  referenceAnalysisSchema,
  referenceJobRequestSchema,
  segmentAnalysisSchema,
} from "../src/domain";
import { errorBody } from "../src/application/errors";
import {
  buildChapterManifest,
  decodeReferenceSource,
  estimateDeconstruction,
  ReferenceRepository,
} from "../src/infrastructure/reference-repository";
import {
  bindSegmentIdentity,
  groupReferenceSegments,
  makeReferenceBatches,
  validateEvidence,
} from "../src/mastra/workflows/reference-deconstruction-workflow";

test("stage aggregation cannot replace the deterministic segment identity", () => {
  const generated = segmentAnalysisSchema.parse({
    id: "arc-1",
    title: "模型自拟阶段",
    chapterIds: ["wrong"],
    summary: "阶段摘要",
    objective: "阶段目标",
    escalation: [],
    characterArcs: [],
    promises: [],
    payoffs: [],
    pacing: "递进",
    evidence: [],
  });
  const bound = bindSegmentIdentity(generated, {
    segmentId: "segment-001",
    title: "片段 1—片段 2",
    chapterIds: ["chapter-0001", "chapter-0002"],
  });
  assert.equal(bound.id, "segment-001");
  assert.deepEqual(bound.chapterIds, ["chapter-0001", "chapter-0002"]);
});

test("reference parser detects headings and covers every character exactly once", () => {
  const content =
    "前言\n说明\n第1卷 起航\n第1章 雨夜\n正文一\n第2章 来客\n正文二\n第3章 决定\n正文三\n";
  const manifest = buildChapterManifest(content, "a".repeat(64));
  assert.equal(manifest.method, "headings");
  assert.equal(manifest.chapters[0]?.kind, "frontmatter");
  assert.equal(manifest.chapters[1]?.volume, "第1卷 起航");
  assert.equal(manifest.chapters[0]?.start, 0);
  assert.equal(manifest.chapters.at(-1)?.end, content.length);
  for (let index = 1; index < manifest.chapters.length; index++)
    assert.equal(
      manifest.chapters[index - 1]?.end,
      manifest.chapters[index]?.start,
    );
});

test("reference parser falls back to paragraph ranges without losing text", () => {
  const content = Array.from(
    { length: 100 },
    (_, index) => `段落${index}。${"内容".repeat(100)}\n\n`,
  ).join("");
  const manifest = buildChapterManifest(content, "b".repeat(64), 1_000);
  assert.equal(manifest.method, "fixed");
  assert.equal(manifest.chapters[0]?.start, 0);
  assert.equal(manifest.chapters.at(-1)?.end, content.length);
  assert.ok(manifest.chapters.length > 10);
});

test("small references still receive the minimum valid budget", () => {
  const manifest = buildChapterManifest("很短的参考文本。", "d".repeat(64));
  assert.equal(
    estimateDeconstruction(manifest, "standard", []).recommendedBudget,
    MIN_REFERENCE_TOKEN_BUDGET,
  );
});

test("invalid reference budgets return a readable client error", () => {
  const parsed = referenceJobRequestSchema.safeParse({
    mode: "standard",
    focuses: [],
    manifestHash: "a".repeat(64),
    tokenBudget: 31_950,
  });
  assert.equal(parsed.success, false);
  const result = errorBody(parsed.error);
  assert.equal(result.status, 400);
  assert.match(result.body.error.message, /100,000/);
});

test("reference import is hash-idempotent and preserves normalized source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-reference-"));
  const repository = new ReferenceRepository(root);
  const bytes = Buffer.from(
    "# 第一章\r\n内容\r\n# 第二章\r\n内容\r\n# 第三章\r\n结尾",
    "utf8",
  );
  const first = await repository.import({
    fileName: "测试.md",
    bytes,
    rightsConfirmed: true,
  });
  const duplicate = await repository.import({
    fileName: "副本.md",
    bytes,
    rightsConfirmed: true,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.referenceId, first.state.referenceId);
  assert.doesNotMatch(
    await readFile(
      path.join(root, first.state.referenceId, "source", "original.txt"),
      "utf8",
    ),
    /\r/,
  );
  const confirmed = await repository.confirmManifest(
    first.state.referenceId,
    first.manifest.sha256,
  );
  assert.equal(confirmed.state.manifestConfirmed, true);
  const estimate = estimateDeconstruction(confirmed.manifest, "deep", [
    "structure",
  ]);
  assert.ok(estimate.recommendedBudget > estimate.inputMax);
});

test("prompt changes mark prior analyses stale without deleting them", async () => {
  const repository = new ReferenceRepository(
    await mkdtemp(path.join(tmpdir(), "ani-reference-stale-")),
  );
  const imported = await repository.import({
    fileName: "测试.txt",
    bytes: Buffer.from("第一段\n\n第二段", "utf8"),
    rightsConfirmed: true,
  });
  const timestamp = new Date().toISOString();
  await repository.updateAnalysis(
    imported.state.referenceId,
    referenceAnalysisSchema.parse({
      id: "analysis-old",
      mode: "standard",
      focuses: [],
      status: "completed",
      sourceHash: imported.state.source.sha256,
      manifestHash: imported.state.manifestHash,
      promptVersion: "1",
      tokenBudget: 100_000,
      reportPath: "report.md",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const state = await repository.propagateStale(
    imported.state.referenceId,
    imported.state.source.sha256,
    imported.state.manifestHash,
    "2",
  );
  assert.deepEqual(state.analyses[0]?.staleReasons, ["prompt"]);
});

test("UTF-8 decoder rejects empty input", () => {
  assert.throws(() => decodeReferenceSource(Buffer.alloc(0)));
});

test("workflow batches cover manifest ranges and cap each model context", () => {
  const chapters = [
    { id: "chapter-0001", title: "长章", start: 0, end: 41_000 },
    { id: "chapter-0002", title: "短章", start: 41_000, end: 45_000 },
  ];
  const batches = makeReferenceBatches(
    "11111111-1111-4111-8111-111111111111",
    "analysis",
    "a".repeat(64),
    "b".repeat(64),
    chapters,
  );
  assert.ok(
    batches.every(
      (batch) =>
        batch.ranges.reduce((sum, item) => sum + item.end - item.start, 0) <=
        18_000,
    ),
  );
  const ranges = batches.flatMap((batch) => batch.ranges);
  assert.equal(ranges[0]?.start, 0);
  assert.equal(ranges.at(-1)?.end, 45_000);
  for (let index = 1; index < ranges.length; index++)
    assert.equal(ranges[index - 1]?.end, ranges[index]?.start);
});

test("evidence validation checks every subrange of an oversized chapter", () => {
  const source = "第一片段内容。第二片段证据。";
  const evidence = validateEvidence(
    [{ chapterId: "chapter-0001", excerpt: "第二片段证据" }],
    [
      { chapterId: "chapter-0001", title: "长章", start: 0, end: 7 },
      {
        chapterId: "chapter-0001",
        title: "长章",
        start: 7,
        end: source.length,
      },
    ],
    source,
  );
  assert.equal(evidence[0]?.start, source.indexOf("第二片段证据"));
});

test("oversized chapters split on paragraph boundaries when source is available", () => {
  const source = `${"甲".repeat(12_000)}\n\n${"乙".repeat(12_000)}`;
  const batches = makeReferenceBatches(
    "11111111-1111-4111-8111-111111111111",
    "analysis",
    "a".repeat(64),
    "b".repeat(64),
    [{ id: "chapter-0001", title: "长章", start: 0, end: source.length }],
    18_000,
    source,
  );
  assert.equal(batches[0]?.ranges[0]?.end, 12_002);
});

test("stage grouping respects volume boundaries before the 25 chapter cap", () => {
  const chapters = Array.from({ length: 30 }, (_, index) => ({
    chapterId: `chapter-${String(index + 1).padStart(4, "0")}`,
  })) as any;
  const volumes = new Map<string, string>(
    chapters.map((item: any, index: number) => [
      item.chapterId,
      index < 12 ? "第一卷" : "第二卷",
    ]),
  );
  assert.deepEqual(
    groupReferenceSegments(chapters, volumes).map((group) => group.length),
    [12, 18],
  );
});

test("synthetic 10MiB novel is covered exactly once without an unbounded model batch", () => {
  const paragraph = `${"a".repeat(7_998)}\n\n`;
  const source = paragraph
    .repeat(Math.ceil((10 * 1024 * 1024) / paragraph.length))
    .slice(0, 10 * 1024 * 1024);
  const manifest = buildChapterManifest(source, "c".repeat(64));
  const batches = makeReferenceBatches(
    "11111111-1111-4111-8111-111111111111",
    "analysis",
    "c".repeat(64),
    manifest.sha256,
    manifest.chapters,
    18_000,
    source,
  );
  const ranges = batches.flatMap((batch) => batch.ranges);
  assert.equal(
    ranges.reduce((sum, item) => sum + item.end - item.start, 0),
    source.length,
  );
  assert.ok(
    batches.every(
      (batch) =>
        batch.ranges.reduce((sum, item) => sum + item.end - item.start, 0) <=
        18_000,
    ),
  );
  assert.equal(
    new Set(ranges.map((item) => item.chapterId)).size,
    manifest.chapters.length,
  );
  assert.ok(
    manifest.chapters.every(
      (chapter) =>
        ranges.filter((item) => item.chapterId === chapter.id).length === 1,
    ),
  );
});
