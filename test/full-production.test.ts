import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NovelRepository, novelInputHash } from "../src/infrastructure/novel-repository";

test("new novels use schema v2 and preserve approval mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-agent-v2-"));
  try {
    const repository = new NovelRepository(root);
    const state = await repository.create("无名测试", "auto");
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.approvalMode, "auto");
    assert.deepEqual(state.continuity, { lastCommittedChapter: 0, revision: 0 });
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
