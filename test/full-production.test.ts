import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { artifactKey, bookStages, decideNextAction } from "../src/domain";
import { NovelRepository, novelInputHash } from "../src/infrastructure/novel-repository";
import { assembleNovelContext } from "../src/application/context-assembler";

test("new novels use schema v2 and preserve approval mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-v2-"));
  try {
    const repository = new NovelRepository(root);
    const state = await repository.create("无名测试", "auto");
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.productionMode, "multi_volume");
    assert.equal(state.approvalMode, "auto");
    assert.deepEqual(state.continuity, { lastCommittedChapter: 0, revision: 0 });
    assert.equal(state.currentVolume, 1);
    assert.deepEqual(state.volumes, {});
    assert.equal(state.productionStatus, "in_progress");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace files are writable without becoming authoritative artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-workspace-files-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("工作区文件测试");
    const first = await repository.writeWorkspaceFile(created.novelId, "notes/draft.md", "# 草稿\n");
    assert.equal(first.created, true);
    assert.equal((await repository.listArtifacts(created.novelId)).length, 0);
    const read = await repository.readWorkspaceFile(created.novelId, "notes/draft.md");
    assert.equal(read.content, "# 草稿\n");
    await assert.rejects(() => repository.writeWorkspaceFile(created.novelId, "../escape.md", "越界\n"), /路径无效/);
    await assert.rejects(() => repository.writeWorkspaceFile(created.novelId, "notes/draft.md", "覆盖\n"), /工作区文件已存在/);
    const updated = await repository.writeWorkspaceFile(created.novelId, "notes/draft.md", "# 更新\n", read.sha256);
    assert.equal(updated.created, false);
    const ideas = await repository.writeWorkspaceFile(created.novelId, "ideas.md", "# 初稿\n");
    await assert.rejects(() => repository.writeWorkspaceFile(created.novelId, "ideas.md", "# 覆盖\n"), /工作区文件已存在/);
    await repository.writeWorkspaceFile(created.novelId, "ideas.md", "# 更新后的想法\n", ideas.sha256);
    await repository.writeWorkspaceFile(created.novelId, "CREATOR.md", "保持克制的近距离叙事。\n");
    assert.match(await assembleNovelContext(repository, created.novelId, []), /作者创作约束[\s\S]*保持克制的近距离叙事/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("volume plans advance the next volume after a stable volume ending", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-volume-cycle-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("卷循环测试");
    await repository.saveOpeningChoices(created.novelId, { channel: "泛读者", format: "免费连载", primaryReward: "成长与反转" });
    await repository.setVolumePlan(created.novelId, { number: 1, startChapter: 1, endChapter: 1, final: false });
    const state = await repository.get(created.novelId);
    const hash = novelInputHash(state, []);
    const result = await repository.commitBundle({ novelId: created.novelId, expectedInputHash: hash, promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "chapter:1:humanization_revision", path: "chapters/chapter-001/draft-humanized.md", content: "第一卷结尾" },
      { key: "chapter:1:continuity_update", path: "continuity/chapter-deltas/chapter-001.yaml", content: "facts: []\n" },
    ] });
    assert.equal(result.state.currentVolume, 2);
    assert.equal(result.state.currentChapter, 2);
    assert.equal(result.state.volumes["1"]?.status, "completed");
    assert.equal(result.state.productionStatus, "in_progress");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("final volume completion enters the completion review stage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-final-volume-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("完本测试");
    await repository.saveOpeningChoices(created.novelId, { channel: "泛读者", format: "免费连载", primaryReward: "成长与反转" });
    await repository.setVolumePlan(created.novelId, { number: 1, startChapter: 1, endChapter: 1, final: true });
    const state = await repository.get(created.novelId);
    const hash = novelInputHash(state, []);
    const result = await repository.commitBundle({ novelId: created.novelId, expectedInputHash: hash, promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "chapter:1:humanization_revision", path: "chapters/chapter-001/draft-humanized.md", content: "最终章" },
      { key: "chapter:1:continuity_update", path: "continuity/chapter-deltas/chapter-001.yaml", content: "facts: []\n" },
    ] });
    assert.equal(result.state.productionStatus, "awaiting_completion_review");
    assert.equal(result.state.currentVolume, 1);
    assert.equal(result.state.artifacts["book:completion_audit"], undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completion audit report controls the final state transition", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-completion-audit-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("验收报告测试");
    await repository.saveOpeningChoices(created.novelId, { channel: "泛读者", format: "免费连载", primaryReward: "成长与反转" });
    await repository.setVolumePlan(created.novelId, { number: 1, startChapter: 1, endChapter: 1, final: true });
    const state = await repository.get(created.novelId);
    const chapterHash = novelInputHash(state, []);
    await repository.commitBundle({ novelId: created.novelId, expectedInputHash: chapterHash, promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "book:novel_brief", path: "book/novel-brief.md", content: "简报" },
      { key: "book:story_bible", path: "story-bible.md", content: "圣经" },
      { key: "book:world_bible", path: "world.md", content: "世界" },
      { key: "book:character_cast", path: "cast.md", content: "角色" },
      { key: "book:volume_strategy", path: "strategy.md", content: "战略" },
      { key: "volume:1:outline", path: "volumes/volume-01.md", content: "卷骨架" },
      { key: "chapter:1:humanization_revision", path: "chapters/chapter-001/draft-humanized.md", content: "最终章" },
      { key: "chapter:1:chapter_review", path: "chapters/chapter-001/review.md", content: "通过" },
      { key: "chapter:1:continuity_update", path: "chapters/chapter-001/continuity.yaml", content: "facts: []\n" },
    ]});
    const reviewState = await repository.get(created.novelId);
    const auditHash = novelInputHash(reviewState, []);
    const baseProposal = { artifactKey: "book:completion_audit", title: "完本验收", format: "markdown" as const, content: "验收", files: [{ path: "production/completion-audit.md", content: "验收" }] };
    const blocked = { ...baseProposal, metadata: { completionAudit: { verdict: "block" as const, summary: "有未兑现承诺", qualityDebt: [], missingChapters: [], unresolvedPromises: ["主线答案"], continuityAnomalies: [] } } };
    await repository.commitProposal({ novelId: created.novelId, proposal: blocked, expectedInputHash: auditHash, promptVersion: "audit@v1", idempotencyKey: `${created.novelId}:book:completion_audit:${auditHash}:audit@v1`, dependsOn: [] });
    assert.equal((await repository.get(created.novelId)).productionStatus, "awaiting_completion_review");
    const passState = await repository.get(created.novelId);
    const passHash = novelInputHash(passState, []);
    const passed = { ...baseProposal, metadata: { completionAudit: { verdict: "pass" as const, summary: "全部收束", qualityDebt: [], missingChapters: [], unresolvedPromises: [], continuityAnomalies: [] } } };
    await repository.commitProposal({ novelId: created.novelId, proposal: passed, expectedInputHash: passHash, promptVersion: "audit@v2", idempotencyKey: `${created.novelId}:book:completion_audit:${passHash}:audit@v2`, dependsOn: [] });
    assert.equal((await repository.get(created.novelId)).productionStatus, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("chapter ranges cannot cross the configured volume boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-volume-boundary-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("卷边界测试");
    await repository.saveOpeningChoices(created.novelId, { channel: "泛读者", format: "免费连载", primaryReward: "成长与反转" });
    await repository.setVolumePlan(created.novelId, { number: 1, startChapter: 1, endChapter: 2, final: false });
    await assert.rejects(() => repository.setChapterRange(created.novelId, 1, 3), /不能超过第 1 卷/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 novels cannot approve chapters before configuring a volume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-volume-required-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("卷配置前置测试");
    await assert.rejects(() => repository.setChapterRange(created.novelId, 1, 2), /请先确定第 1 卷/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("next volume cannot be configured until the previous handoff is committed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-handoff-required-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("承接前置测试");
    await repository.saveOpeningChoices(created.novelId, { channel: "泛读者", format: "免费连载", primaryReward: "成长与反转" });
    await repository.setVolumePlan(created.novelId, { number: 1, startChapter: 1, endChapter: 1, final: false });
    const state = await repository.get(created.novelId);
    await repository.commitBundle({ novelId: created.novelId, expectedInputHash: novelInputHash(state, []), promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "chapter:1:humanization_revision", path: "chapters/chapter-001/draft-humanized.md", content: "卷末" },
      { key: "chapter:1:continuity_update", path: "continuity/chapter-deltas/chapter-001.yaml", content: "facts: []\n" },
    ] });
    await assert.rejects(() => repository.setVolumePlan(created.novelId, { number: 2, startChapter: 2, endChapter: 2, final: true }), /卷间承接包/);
    const current = await repository.get(created.novelId);
    const handoff = { artifactKey: "volume:1:handoff", title: "卷间承接包", format: "markdown" as const, content: "承接", files: [{ path: "volumes/volume-01-handoff.md", content: "承接" }], metadata: {} };
    const hash = novelInputHash(current, []);
    await repository.commitProposal({ novelId: created.novelId, proposal: handoff, expectedInputHash: hash, promptVersion: "handoff@v1", idempotencyKey: `${created.novelId}:volume:1:handoff:${hash}:handoff@v1`, dependsOn: [] });
    await repository.setVolumePlan(created.novelId, { number: 2, startChapter: 2, endChapter: 2, final: true });
    assert.equal((await repository.get(created.novelId)).volumes["2"]?.startChapter, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy state is backed up only when the first mutation occurs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-migrate-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("旧作品");
    const statePath = path.join(root, created.novelId, "novel-state.yaml");
    const v1 = (await readFile(statePath, "utf8")).replace("schemaVersion: 2", "schemaVersion: 1");
    await writeFile(statePath, v1, "utf8");
    assert.equal((await repository.get(created.novelId)).schemaVersion, 1);
    await repository.saveOpeningChoices(created.novelId, { channel: "广泛受众", format: "免费连载", primaryReward: "成长反转" });
    assert.equal((await repository.get(created.novelId)).schemaVersion, 2);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(path.dirname(statePath)));
    assert.ok(files.some((name) => name.startsWith("novel-state.v1-backup-")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pre-volume schema v2 novels keep the legacy chapter production chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-legacy-v2-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("旧版续写");
    const statePath = path.join(root, created.novelId, "novel-state.yaml");
    const raw = parse(await readFile(statePath, "utf8")) as Record<string, any>;
    delete raw.productionMode;
    delete raw.currentVolume;
    delete raw.volumes;
    delete raw.productionStatus;
    raw.currentChapter = 2;
    raw.approvedChapterEnd = 5;
    raw.openingChoices = { channel: "网络文学", format: "长篇连载", primaryReward: "成长与反转" };
    raw.continuity = { lastCommittedChapter: 1, revision: 1 };
    raw.artifacts = Object.fromEntries(bookStages.map((stage) => [artifactKey(stage), { stage, path: `${stage}.md`, status: "ready", protected: false }]));
    await writeFile(statePath, stringify(raw), "utf8");

    const legacy = await repository.get(created.novelId);
    assert.equal(legacy.productionMode, "legacy");
    assert.deepEqual(decideNextAction(legacy), { type: "produce_artifact", stage: "chapter_plan", artifactKey: "chapter:2:chapter_plan", workflowId: "chapter-planning", reason: "推进第 2 章的 chapter_plan。" });

    const hash = novelInputHash(legacy, []);
    const committed = await repository.commitBundle({ novelId: created.novelId, expectedInputHash: hash, promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "chapter:2:humanization_revision", path: "chapters/chapter-002/draft-humanized.md", content: "第二章" },
      { key: "chapter:2:continuity_update", path: "continuity/chapter-deltas/chapter-002.yaml", content: "facts: []\n" },
    ] });
    assert.equal(committed.state.productionMode, "legacy");
    assert.equal(committed.state.currentChapter, 3);
    assert.equal((parse(await readFile(statePath, "utf8")) as Record<string, unknown>).productionMode, "legacy");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bundle commit advances continuity only after stable chapter files exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-chapter-"));
  try {
    const repository = new NovelRepository(root);
    const state = await repository.create("章节测试");
    const hash = novelInputHash(state, []);
    const result = await repository.commitBundle({ novelId: state.novelId, expectedInputHash: hash, promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "chapter:1:context_package", path: "chapters/chapter-001/context-package.md", content: "权威上下文" },
      { key: "chapter:1:chapter_draft", path: "chapters/chapter-001/draft.md", content: "初稿" },
      { key: "chapter:1:humanization_revision", path: "chapters/chapter-001/draft-humanized.md", content: "定稿" },
      { key: "chapter:1:chapter_review", path: "chapters/chapter-001/review.md", content: "accepted" },
      { key: "chapter:1:continuity_update", path: "continuity/chapter-deltas/chapter-001.yaml", content: "facts: []\n" },
    ] });
    assert.equal(result.state.currentChapter, 2);
    assert.equal(result.state.continuity?.lastCommittedChapter, 1);
    assert.equal(result.state.artifacts["chapter:1:context_package"]?.status, "ready");
    assert.equal(await readFile(path.join(root, state.novelId, "chapters/chapter-001/draft-humanized.md"), "utf8"), "定稿");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exports can only be downloaded through recorded export artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-export-"));
  try {
    const repository = new NovelRepository(root);
    const state = await repository.create("导出测试");
    const hash = novelInputHash(state, []);
    await repository.commitBundle({ novelId: state.novelId, expectedInputHash: hash, promptVersion: "test@v1", dependsOn: [], artifacts: [
      { key: "chapter:1:humanization_revision", path: "chapters/chapter-001/draft-humanized.md", content: "第一章正文" },
    ] });
    const exported = await repository.exportStableChapters(state.novelId);
    assert.match((await repository.readExport(state.novelId, exported.path)).content, /第一章正文/);
    await assert.rejects(repository.readExport(state.novelId, "../novel-state.yaml"), /没有找到/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact paths cannot escape the novel workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-path-"));
  try {
    const repository = new NovelRepository(root);
    const state = await repository.create("路径测试");
    const hash = novelInputHash(state);
    await assert.rejects(repository.commitProposal({ novelId: state.novelId, expectedInputHash: hash, promptVersion: "test@v1", idempotencyKey: `${state.novelId}:book:story_bible:${hash}:test@v1`, proposal: { artifactKey: "book:story_bible", title: "故事圣经", format: "markdown", content: "bad", files: [{ path: "../escape.md", content: "bad" }], metadata: {} } }), /路径无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
