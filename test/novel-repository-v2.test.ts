import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "../src/application/errors";
import { NovelRepository, novelStateHash } from "../src/infrastructure/novel-repository";

const ledger = "version: 1\ndecisions: []\ncharacters: []\nworldRules: []\nopenThreads: []\ncontinuity: []\n";
const isCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test("repository enforces hashes, approval, protection, serial chapters and export", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-v2-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("边界测试");
    assert.equal(novelStateHash(created), novelStateHash(Object.fromEntries(Object.entries(created).reverse()) as typeof created));
    await stat(path.join(root, created.novelId, "workspace", "references"));
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "越权", summary: "越权", changes: [{ operation: "create", path: "../outside.md", content: "x" }] }), isCode("INVALID_NOVEL_PATH"));
    await assert.rejects(
      () => repository.prepareProposal(created.novelId, { intent: "错误账本", summary: "错误账本", changes: [{ operation: "create", path: "book/ledger.yaml", content: "version: 1\ndecisions:\n  - id: d1\n    topic: 错误字段\n" }] }),
      (error: unknown) => error instanceof AppError && error.code === "LEDGER_INVALID" && error.message.includes("decisions.0.text"),
    );
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "半份开书", summary: "只有蓝图", changes: [{ operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" }] }), isCode("LEDGER_REQUIRED"));

    const opening = await repository.prepareProposal(created.novelId, {
      intent: "确认开书",
      summary: "写入蓝图和账本",
      changes: [
        { operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" },
        { operation: "create", path: "book/ledger.yaml", content: ledger },
      ],
    });
    assert.equal(opening.approval, "author");
    await assert.rejects(() => repository.applyProposal(opening), isCode("AUTHOR_APPROVAL_REQUIRED"));
    const applied = await repository.applyProposal(opening, true);
    assert.equal(applied.state.phase, "writing");
    assert.equal((await repository.applyProposal(opening, true)).duplicate, true);

    const blueprint = await repository.readProjectFile(created.novelId, "book/blueprint.md");
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "无哈希", summary: "无哈希", changes: [{ operation: "replace", path: blueprint.path, content: "新蓝图" }] }), isCode("BASE_HASH_REQUIRED"));
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "旧哈希", summary: "旧哈希", changes: [{ operation: "replace", path: blueprint.path, baseSha256: "0".repeat(64), content: "新蓝图" }] }), isCode("FILE_STALE"));

    await assert.rejects(() => repository.commitChapter(created.novelId, 2, "# 第二章", { characterUpdates: [], worldRules: [], threads: [], changes: [] }), isCode("CHAPTER_SEQUENCE"));
    await repository.commitChapter(created.novelId, 1, "# 第一章\n正文", { characterUpdates: [], worldRules: [], threads: [{ id: "promise", kind: "promise", text: "找到故乡", status: "open" }], changes: ["主角离村"] });
    const chapter = await repository.readProjectFile(created.novelId, "chapters/chapter-001.md");
    const saved = await repository.saveAuthorFile(created.novelId, chapter.path, `${chapter.content}\n作者修改`, chapter.sha256);
    assert.equal(saved.source, "author");
    assert.equal(saved.protected, true);
    const protectedPatch = await repository.prepareProposal(created.novelId, { intent: "修改正文", summary: "修改正文", changes: [{ operation: "replace", path: saved.path, baseSha256: saved.sha256, content: `${saved.content}\nAgent 修改` }] });
    assert.equal(protectedPatch.approval, "author");
    await assert.rejects(() => repository.applyProposal(protectedPatch), isCode("AUTHOR_APPROVAL_REQUIRED"));

    await repository.setActiveJob(created.novelId, "job-1");
    await assert.rejects(() => repository.setActiveJob(created.novelId, "job-2"), isCode("ACTIVE_JOB"));
    assert.equal((await repository.clearActiveJob(created.novelId, "other-job")).activeJobId, "job-1");
    await repository.clearActiveJob(created.novelId, "job-1");

    const exported = await repository.exportNovel(created.novelId);
    assert.equal(exported.chapterCount, 1);
    assert.match(exported.content, /第一章/);
    assert.equal((await repository.readProjectFile(created.novelId, exported.path)).content, exported.content);

    const beforeExternalEdit = await repository.prepareProposal(created.novelId, { intent: "修改蓝图", summary: "修改蓝图", changes: [{ operation: "replace", path: blueprint.path, baseSha256: blueprint.sha256, content: "# Agent 新蓝图\n" }] });
    const blueprintPath = path.join(root, created.novelId, "book", "blueprint.md");
    await writeFile(blueprintPath, "# 作者在本地改过的蓝图\n", "utf8");
    await assert.rejects(() => repository.applyProposal(beforeExternalEdit, true), isCode("FILE_STALE"));
    const reconciled = await repository.readProjectFile(created.novelId, "book/blueprint.md");
    assert.equal(reconciled.source, "author");
    assert.equal(reconciled.protected, true);
    assert.equal(reconciled.version, blueprint.version + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
