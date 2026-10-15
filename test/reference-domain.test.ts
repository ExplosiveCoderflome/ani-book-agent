import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateTokenCount } from "tokenx";
import { stringify } from "yaml";
import { REFERENCE_SEGMENT_INPUT_TOKENS, modelSegmentSchema, validateSegmentOutput } from "../src/mastra/workflows/reference-deconstruction-support";
import {
  MIN_REFERENCE_TOKEN_BUDGET,
  chapterParserConfigSchema,
  normalizeChapterPatternSuggestion,
  referenceAnalysisSchema,
  referenceAnalysisPresetSections,
  referenceJobRequestSchema,
  referenceSectionSchema,
  segmentAnalysisSchema,
} from "../src/domain";
import { errorBody } from "../src/application/errors";
import { matchChapterPatterns } from "../src/infrastructure/chapter-pattern-matcher";
import {
  buildChapterManifest,
  decodeReferenceSource,
  estimateDeconstruction,
  referenceChaptersInRange,
  ReferenceRepository,
} from "../src/infrastructure/reference-repository";
import {
  bindSegmentIdentity,
  groupReferenceSegments,
  makeReferenceBatches,
  modelBatchSchema,
  validateEvidence,
} from "../src/mastra/workflows/reference-deconstruction-workflow";

test("chapter model output fills harmless omissions before strict domain validation", () => {
  const parsed = modelBatchSchema.parse({
    chapters: [{
      chapterId: "chapter-0028",
      title: "第二十八章",
      scenes: [{ goal: "角色试图脱困" }],
      characterChanges: [{ name: "林川" }],
      causalEvents: [],
      worldRules: [],
      threads: [{ text: "身份谜团" }],
      rewards: [],
      evidence: [{}],
    }],
  });
  assert.equal(parsed.chapters[0]?.characterChanges[0]?.after, "本片段未明确交代变化后的状态");
  assert.equal(parsed.chapters[0]?.characterChanges[0]?.cause, "本片段未明确交代变化原因");
  assert.equal(parsed.chapters[0]?.endingHook, "本章自然收束，无明确的章末钩子");
  assert.equal(parsed.chapters[0]?.summary, "本片段未提供摘要");
  assert.equal(parsed.chapters[0]?.scenes[0]?.outcome, "本片段未明确场景结果");
  assert.equal(parsed.chapters[0]?.threads[0]?.action, "advanced");
});

test("analysis presets select stable beginner-facing section sets", () => {
  assert.deepEqual(referenceAnalysisPresetSections.quick, ["overview", "plot_structure", "character_system", "style_technique"]);
  assert.ok(referenceAnalysisPresetSections.standard.includes("market_highlights"));
  assert.ok(referenceAnalysisPresetSections.complete.includes("timeline"));
  const section = referenceSectionSchema.parse({ version: 1, key: "plot_structure", title: "剧情结构", summary: "结构结论", content: "## 完整解释\n\n说明结构如何服务连载。", structuredData: {}, evidence: [], insights: [{ id: "pressure-loop", title: "压力循环", mechanism: "每次兑现后立刻给出更高代价。", fitFor: ["升级线"], doNotCopy: ["原作事件组合"], adaptationHint: "换成自己的目标与代价。", evidence: [] }], characterCandidates: [], createdAt: new Date().toISOString() });
  assert.equal(section.insights[0]?.title, "压力循环");
});

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

test("stage and macro evidence offsets come from verified source text", () => {
  const source = "序言。第一章真实证据。第二章真实证据。";
  const ranges = [{ chapterId: "chapter-1", title: "第一章", start: 3, end: 11 }];
  const raw = { id: "stage", title: "阶段", chapterIds: ["chapter-1"], summary: "摘要", objective: "目标", escalation: [], characterArcs: [], promises: [], payoffs: [], pacing: "递进", evidence: [
    { chapterId: "chapter-1", excerpt: "真实证据", start: 0, end: 0 },
    { chapterId: "chapter-1", excerpt: "不存在的引用", start: 1, end: 99 },
    { chapterId: "chapter-2", excerpt: "真实证据", start: 14, end: 18 },
  ] };
  assert.equal(modelSegmentSchema.safeParse(raw).success, true);
  const result = validateSegmentOutput(raw, ranges, source);
  assert.deepEqual(result.evidence, [{ chapterId: "chapter-1", excerpt: "真实证据", start: 6, end: 10 }]);
  assert.equal(segmentAnalysisSchema.safeParse(result).success, true);
  assert.throws(() => validateSegmentOutput({ ...raw, objective: undefined }, ranges, source));
});

test("reference parser detects headings and covers every character exactly once", async () => {
  const content =
    "前言\n说明\n第1卷 起航\n第1章 雨夜\n正文一\n第2章 来客\n正文二\n第3章 决定\n正文三\n";
  const manifest = await buildChapterManifest(content, "a".repeat(64));
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

test("reference parser accepts common web-novel chapter labels without creating separator frontmatter", async () => {
  const content = [
    "------------\n\n001章\n\n正文一。\n",
    "------------\n\n002章 新的局面\n\n正文二。\n",
    "【第叁回：夜归】\n\n正文三。\n",
    "Chapter 004 Return\n\n正文四。\n",
  ].join("");
  const manifest = await buildChapterManifest(content, "c".repeat(64));
  assert.equal(manifest.method, "headings");
  assert.equal(manifest.chapters.length, 4);
  assert.equal(manifest.chapters[0]?.title, "001章");
  assert.equal(manifest.chapters[1]?.title, "002章 新的局面");
  assert.equal(manifest.chapters[2]?.title, "第叁回：夜归");
  assert.equal(manifest.chapters[0]?.start, content.indexOf("001章"));
  assert.equal(manifest.chapters.at(-1)?.end, content.length);
});

test("reference parser keeps a chapter boundary but shortens a title glued to prose", async () => {
  const glued = `295章 ${"正文粘在标题后".repeat(30)}。后续正文`;
  const content = `001章\n正文\n002章\n正文\n${glued}\n正文\n`;
  const manifest = await buildChapterManifest(content, "f".repeat(64));
  assert.equal(manifest.chapters.length, 3);
  assert.ok((manifest.chapters[2]?.title.length ?? 0) <= 81);
  assert.equal(manifest.chapters[2]?.start, content.indexOf("295章"));
});

test("reference parser applies an author-defined anchored regular expression", async () => {
  const parser = chapterParserConfigSchema.parse({ version: 1, patterns: [{ id: "author-scene", name: "场次标题", pattern: "^SCENE\\s+\\d+", enabled: true, source: "author" }] });
  const content = "SCENE 1\n正文\nSCENE 2\n正文\nSCENE 3\n正文\n";
  const manifest = await buildChapterManifest(content, "9".repeat(64), 8_000, parser);
  assert.equal(manifest.method, "headings");
  assert.deepEqual(manifest.chapters.map((item) => item.title), ["SCENE 1", "SCENE 2", "SCENE 3"]);
  assert.equal(chapterParserConfigSchema.safeParse({ version: 1, patterns: [{ id: "broken", name: "错误", pattern: "[", enabled: true, source: "author" }] }).success, false);
});

test("AI chapter regex normalization repairs transport escaping and wrappers", async () => {
  const base = { name: "三位数字章节", explanation: "匹配三位数字章节。" };
  const escaped = await normalizeChapterPatternSuggestion({ ...base, pattern: String.raw`^\\d{3}章$` }, "001章", matchChapterPatterns);
  assert.equal(escaped?.pattern, String.raw`^\d{3}章$`);
  const wrapped = await normalizeChapterPatternSuggestion({ ...base, pattern: "```regex\n/^\\d{3}章$/u\n```" }, "001章", matchChapterPatterns);
  assert.equal(wrapped?.pattern, String.raw`^\d{3}章$`);
});

test("reference parser falls back to paragraph ranges without losing text", async () => {
  const content = Array.from(
    { length: 100 },
    (_, index) => `段落${index}。${"内容".repeat(100)}\n\n`,
  ).join("");
  const manifest = await buildChapterManifest(content, "b".repeat(64), 1_000);
  assert.equal(manifest.method, "fixed");
  assert.equal(manifest.chapters[0]?.start, 0);
  assert.equal(manifest.chapters.at(-1)?.end, content.length);
  assert.ok(manifest.chapters.length > 10);
});

test("small references still receive the minimum valid budget", async () => {
  const manifest = await buildChapterManifest("很短的参考文本。", "d".repeat(64));
  assert.equal(
    estimateDeconstruction(manifest, "standard", []).recommendedBudget,
    MIN_REFERENCE_TOKEN_BUDGET,
  );
});

test("chapter range limits estimates and selected workflow chapters", async () => {
  const content = Array.from({ length: 8 }, (_, index) => `${String(index + 1).padStart(3, "0")}章\n${"正文".repeat(2_000)}\n`).join("");
  const manifest = await buildChapterManifest(content, "8".repeat(64));
  const range = { fromChapter: 3, toChapter: 5 };
  const selected = referenceChaptersInRange(manifest, range);
  assert.deepEqual(selected.map((chapter) => chapter.title), ["003章", "004章", "005章"]);
  const batches = makeReferenceBatches("11111111-1111-4111-8111-111111111111", "analysis-range", manifest.sourceHash, manifest.sha256, selected, 18_000, content);
  assert.deepEqual([...new Set(batches.flatMap((batch) => batch.ranges.map((item) => item.chapterId)))], selected.map((chapter) => chapter.id));
  assert.ok(estimateDeconstruction(manifest, "standard", [], range).inputMax < estimateDeconstruction(manifest, "standard", []).inputMax);
  assert.throws(() => referenceChaptersInRange(manifest, { fromChapter: 1, toChapter: 9 }), /不能超过第 8 章/);
  assert.equal(referenceJobRequestSchema.safeParse({ mode: "standard", focuses: [], manifestHash: "a".repeat(64), tokenBudget: 100_000, chapterRange: { fromChapter: 5, toChapter: 3 } }).success, false);
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
  });
  const duplicate = await repository.import({
    fileName: "副本.md",
    bytes,
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

test("saved chapter parser rules rebuild an existing reference manifest", async () => {
  const repository = new ReferenceRepository(await mkdtemp(path.join(tmpdir(), "ani-reference-parser-")));
  const imported = await repository.import({ fileName: "场次.txt", bytes: Buffer.from("SCENE 1\n正文\nSCENE 2\n正文\nSCENE 3\n正文", "utf8") });
  const parser = chapterParserConfigSchema.parse({ version: 1, patterns: [{ id: "scene", name: "场次", pattern: "^SCENE\\s+\\d+", enabled: true, source: "author" }] });
  await repository.saveParser(imported.state.referenceId, parser);
  const rebuilt = await repository.rebuildManifest(imported.state.referenceId);
  assert.equal(rebuilt.manifest.method, "headings");
  assert.equal(rebuilt.manifest.chapters.length, 3);
  assert.deepEqual(await repository.parser(imported.state.referenceId), parser);
});

test("prompt changes mark prior analyses stale without deleting them", async () => {
  const repository = new ReferenceRepository(
    await mkdtemp(path.join(tmpdir(), "ani-reference-stale-")),
  );
  const imported = await repository.import({
    fileName: "测试.txt",
    bytes: Buffer.from("第一段\n\n第二段", "utf8"),
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

test("clearing analyses keeps the imported source and chapter manifest", async () => {
  const repository = new ReferenceRepository(await mkdtemp(path.join(tmpdir(), "ani-reference-clear-")));
  const imported = await repository.import({ fileName: "保留原文.txt", bytes: Buffer.from("第一章\n正文", "utf8") });
  const timestamp = new Date().toISOString();
  await repository.updateAnalysis(imported.state.referenceId, referenceAnalysisSchema.parse({ id: "old", mode: "standard", preset: "quick", sectionKeys: referenceAnalysisPresetSections.quick, focuses: [], status: "completed", sourceHash: imported.state.source.sha256, manifestHash: imported.state.manifestHash, promptVersion: "3", tokenBudget: 100_000, createdAt: timestamp, updatedAt: timestamp }));
  await repository.writeAnalysisFile(imported.state.referenceId, "old", "sections/overview.yaml", "version: 1\nkey: overview\ntitle: 总览\nsummary: 旧结果\ncontent: 旧结果的完整说明\ncreatedAt: '2026-01-01T00:00:00.000Z'\n");
  const cleared = await repository.clearAnalyses(imported.state.referenceId);
  assert.equal(cleared.analyses.length, 0);
  assert.match(await repository.source(imported.state.referenceId), /第一章/);
  assert.equal((await repository.manifest(imported.state.referenceId)).chapters.length, 1);
});

test("clearing analyses is rejected while another reference job is active", async () => {
  const repository = new ReferenceRepository(await mkdtemp(path.join(tmpdir(), "ani-reference-active-clear-")));
  const imported = await repository.import({ fileName: "运行中.txt", bytes: Buffer.from("第一章\n正文", "utf8") });
  await repository.setActive("job-running", imported.state.referenceId);
  await assert.rejects(() => repository.clearAnalyses(imported.state.referenceId), /不能清理/);
});

test("section storage accepts stable keys containing underscores", async () => {
  const repository = new ReferenceRepository(await mkdtemp(path.join(tmpdir(), "ani-reference-section-key-")));
  const imported = await repository.import({ fileName: "小节键.txt", bytes: Buffer.from("第一章\n正文", "utf8") });
  await repository.writeAnalysisFile(imported.state.referenceId, "analysis", "sections/plot_structure.yaml", "key: plot_structure\n");
  assert.match(await repository.readAnalysisFile(imported.state.referenceId, "analysis", "sections/plot_structure.yaml"), /plot_structure/);
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

test("stage grouping bounds serialized analysis tokens without losing chapters", () => {
  const chapters = Array.from({ length: 30 }, (_, index) => ({ chapterId: `chapter-${index}`, title: `第${index}章`, summary: "这是角色变化以及关键事件的分析。".repeat(300) })) as any;
  const groups = groupReferenceSegments(chapters, new Map());
  assert.ok(groups.length > 2);
  assert.deepEqual(groups.flat(), chapters);
  for (const group of groups) {
    assert.ok(group.length <= 25);
    assert.ok(estimateTokenCount(group.map((chapter) => stringify(chapter, { lineWidth: 0 })).join("\n\n")) <= REFERENCE_SEGMENT_INPUT_TOKENS);
  }
  assert.throws(() => groupReferenceSegments([{ ...chapters[0], summary: "这是角色变化以及关键事件的分析。".repeat(10_000) }], new Map()), /章节分析超过阶段聚合输入预算/);
  assert.deepEqual(groupReferenceSegments([], new Map()), []);
});

test("synthetic 10MiB novel is covered exactly once without an unbounded model batch", async () => {
  const paragraph = `${"a".repeat(7_998)}\n\n`;
  const source = paragraph
    .repeat(Math.ceil((10 * 1024 * 1024) / paragraph.length))
    .slice(0, 10 * 1024 * 1024);
  const manifest = await buildChapterManifest(source, "c".repeat(64));
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
