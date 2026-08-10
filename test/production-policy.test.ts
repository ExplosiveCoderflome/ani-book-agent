import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { artifactKey, bookStages, decideNextAction, type NovelState } from "../src/domain";
import { createNovelBriefWorkflow } from "../src/mastra/workflows/advance-novel-workflow";
import { promptVersion, type NovelBrief } from "../src/shared/contracts";
import { resolveMastraStorageUrl, resolveRuntimeDatabasePath } from "../src/mastra/storage-url";

const baseState = (): NovelState => ({
  schemaVersion: 1,
  novelId: "novel-1",
  title: "测试小说",
  currentChapter: 1,
  approvedChapterEnd: 0,
  artifacts: {},
});

test("domain policy requests opening choices before any model work", () => {
  assert.equal(decideNextAction(baseState()).type, "collect_opening_choices");
});

test("domain policy preserves the serial artifact chain before chapter approval", () => {
  const state = baseState();
  state.openingChoices = { channel: "男频", format: "免费连载", primaryReward: "成长与反转" };
  for (const stage of bookStages) {
    state.artifacts[artifactKey(stage)] = {
      stage,
      status: "ready",
      path: `${stage}.md`,
      protected: false,
      userEdited: false,
    };
  }

  assert.deepEqual(decideNextAction(state), {
    type: "approve_chapter_range",
    chapter: 1,
    reason: "第 1 章尚未获得生产授权。",
  });
});

test("domain policy closes chapter quality debt before approving more chapters", () => {
  const state = baseState();
  state.openingChoices = { channel: "男频", format: "免费连载", primaryReward: "成长与反转" };
  state.schemaVersion = 2;
  state.currentChapter = 2;
  state.approvedChapterEnd = 10;
  state.continuity = { lastCommittedChapter: 1, revision: 1 };
  for (const stage of bookStages) state.artifacts[artifactKey(stage)] = { stage, status: "ready", path: `${stage}.md`, protected: false };
  state.artifacts["chapter:1:quality_debt"] = { status: "ready", path: "production/quality-debt-chapter-001.md", protected: false };
  assert.deepEqual(decideNextAction(state), {
    type: "produce_artifact",
    stage: "quality_repair",
    artifactKey: "chapter:1:quality_repair",
    workflowId: "quality-repair",
    reason: "先处理第 1 章尚未关闭的质量债。",
  });
  state.artifacts["chapter:1:quality_repair"] = { stage: "quality_repair", status: "ready", path: "chapters/chapter-001/repair-proposal.md", protected: false };
  assert.deepEqual(decideNextAction(state), { type: "produce_artifact", stage: "chapter_plan", artifactKey: "chapter:2:chapter_plan", workflowId: "chapter-planning", reason: "推进第 2 章的 chapter_plan。" });
});

test("Mastra workflow suspends for review and commits the edited proposal", async () => {
  const brief: NovelBrief = {
    workingTitle: "测试小说",
    oneSentencePremise: "一句话故事",
    targetReaders: "喜欢成长故事的读者",
    primaryReaderReward: "成长与反转",
    protagonist: "一名失去身份的少年",
    coreConflict: "他必须在秘密暴露前夺回故乡",
    storyEngine: "升级、结盟、发现线索并解决更强敌人",
    openingHook: "主角在处刑台上收到未来自己的警告",
    longTermPromise: "揭开王朝循环覆灭的真相",
    risks: ["升级节奏可能过快"],
  };
  let committed: NovelBrief | undefined;
  const workflow = createNovelBriefWorkflow({
    generateBrief: async () => brief,
    commitBrief: async (input) => {
      committed = input.approvedBrief;
      return { sha256: "a".repeat(64), duplicate: false };
    },
  });
  new Mastra({ storage: new InMemoryStore(), workflows: { workflow } });
  const run = await workflow.createRun();
  const inputData = {
    novelId: "52ac4f1c-1e7f-4a50-a0bd-c71475d23ddb",
    title: "测试小说",
    openingChoices: { channel: "男频", format: "免费连载", primaryReward: "成长与反转" },
    inputHash: "b".repeat(64),
    promptVersion,
  };
  const suspended = await run.start({ inputData });
  assert.equal(suspended.status, "suspended");
  const edited = { ...brief, openingHook: "作者修改后的开篇钩子" };
  const result = await run.resume({ step: "review-novel-brief", resumeData: { action: "approve", brief: edited } });
  assert.equal(result.status, "success");
  assert.equal(committed?.openingHook, edited.openingHook);
});

test("Mastra storage creates its local data directory before libSQL opens", () => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "ani-novel-agent-"));
  try {
    const storageUrl = resolveMastraStorageUrl({ projectDirectory });
    assert.equal(storageUrl, pathToFileURL(path.join(projectDirectory, ".runtime", "mastra.db")).href);
    assert.equal(existsSync(path.join(projectDirectory, ".runtime")), true);
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("observability storage resolves a native DuckDB path", () => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "ani-novel-observability-"));
  const previousCwd = process.cwd();
  const previousInitCwd = process.env.INIT_CWD;
  try {
    process.chdir(projectDirectory);
    delete process.env.INIT_CWD;
    assert.equal(resolveRuntimeDatabasePath("observability.duckdb"), path.join(projectDirectory, ".runtime", "observability.duckdb"));
  } finally {
    process.chdir(previousCwd);
    if (previousInitCwd === undefined) delete process.env.INIT_CWD; else process.env.INIT_CWD = previousInitCwd;
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});
