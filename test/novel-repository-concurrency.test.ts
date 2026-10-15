import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { NovelState, PatchProposal } from "../src/domain";
import { AppError } from "../src/application/errors";
import { NovelRepository, sha256 } from "../src/infrastructure/novel-repository";
import { acceptedReview, chapterBasis, prepareWriting } from "./novel-test-fixture";

const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;
const run = promisify(execFile);
const repositoryUrl = new URL("../src/infrastructure/novel-repository.ts", import.meta.url).href;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "ani-repository-concurrency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new NovelRepository(root);
  const novel = await repository.create("存储回归");
  return { root, repository, id: novel.novelId, directory: path.join(root, novel.novelId) };
}

async function propose(repository: NovelRepository, id: string, changes: PatchProposal["changes"]) {
  return repository.prepareProposal(id, { intent: "回归提交", summary: "验证存储边界", changes });
}

test("parallel proposals, author saves and job activation retain every state change across repository instances", async (t) => {
  const { root, repository, id } = await fixture(t);
  const second = new NovelRepository(root);
  const a = await propose(repository, id, [{ operation: "create", path: "workspace/a.md", content: "A" }]);
  const b = await propose(second, id, [{ operation: "create", path: "workspace/b.md", content: "B" }]);
  const ideas = await repository.readProjectFile(id, "workspace/ideas.md");
  await Promise.all([
    repository.applyProposal(a), second.applyProposal(b),
    repository.saveAuthorFile(id, ideas.path, "作者灵感", ideas.sha256), second.claimProductionJob(id, "job-1", { goal: "review_project", scope: {} }, "standard"),
  ]);
  const state = await repository.get(id);
  assert.deepEqual(Object.keys(state.files).filter((file) => !file.startsWith("workspace/proposals/")).sort(), ["workspace/a.md", "workspace/b.md", "workspace/ideas.md"]);
  assert.equal(state.files[ideas.path]?.sha256, sha256("作者灵感"));
  assert.equal(state.activeJobId, "job-1");
  assert.deepEqual(new Set(state.appliedProposalIds), new Set([a.id, b.id]));
});

test("competing author saves and active jobs validate against the latest state; duplicate proposals apply once", async (t) => {
  const { repository, id } = await fixture(t);
  const file = await repository.readProjectFile(id, "workspace/ideas.md");
  const saves = await Promise.allSettled(["A", "B"].map((content) => repository.saveAuthorFile(id, file.path, content, file.sha256)));
  assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(saves.some((result) => result.status === "rejected" && code("FILE_STALE")(result.reason)));
  assert.equal((await repository.get(id)).files[file.path]?.version, 2);
  const jobs = await Promise.allSettled(["one", "two"].map((job) => repository.claimProductionJob(id, job, { goal: "review_project", scope: {} }, "standard")));
  assert.equal(jobs.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(jobs.some((result) => result.status === "rejected" && code("ACTIVE_JOB")(result.reason)));
  const proposal = await propose(repository, id, [{ operation: "create", path: "workspace/once.md", content: "once" }]);
  const applied = await Promise.all([repository.applyProposal(proposal), repository.applyProposal(proposal)]);
  assert.deepEqual(applied.map((result) => result.duplicate), [false, true]);
});

test("parallel external edit reconciliation preserves both author protection records", async (t) => {
  const { repository, id, directory } = await fixture(t);
  await repository.applyProposal(await propose(repository, id, ["a", "b"].map((name) => ({ operation: "create", path: `workspace/${name}.md`, content: name }))));
  await Promise.all(["a", "b"].map((name) => writeFile(path.join(directory, "workspace", `${name}.md`), `author ${name}`)));
  await Promise.all(["a", "b"].map((name) => repository.readProjectFile(id, `workspace/${name}.md`)));
  const state = await repository.get(id);
  for (const name of ["a", "b"]) {
    assert.equal(state.files[`workspace/${name}.md`]?.sha256, sha256(`author ${name}`));
    assert.equal(state.files[`workspace/${name}.md`]?.source, "author");
    assert.equal(state.files[`workspace/${name}.md`]?.protected, true);
  }
});

test("agent create and chapter commit preserve author files that are not registered in state", async (t) => {
  const { repository, id, directory } = await fixture(t);
  const proposal = await propose(repository, id, [{ operation: "create", path: "workspace/external.md", content: "agent" }]);
  const target = path.join(directory, "workspace/external.md");
  await writeFile(target, "author file");
  await assert.rejects(repository.applyProposal(proposal), code("FILE_EXISTS"));
  await assert.rejects(propose(repository, id, [{ operation: "create", path: "workspace/external.md", content: "agent" }]), code("FILE_EXISTS"));
  assert.equal(await readFile(target, "utf8"), "author file");
  const { jobId, basis } = await prepareWriting(repository, id);
  await mkdir(path.join(directory, "chapters"), { recursive: true });
  await writeFile(path.join(directory, "chapters/chapter-001.md"), "author chapter");
  await assert.rejects(repository.commitChapter(id, { jobId, chapter: 1, text: "AI overwrite", review: acceptedReview(), basis }), code("FILE_EXISTS"));
  assert.equal(await readFile(path.join(directory, "chapters/chapter-001.md"), "utf8"), "author chapter");
  assert.equal((await repository.get(id)).nextChapter, 1);
});

test("same-novel readers wait for commit while a different novel remains available", async (t) => {
  const { repository, id } = await fixture(t);
  const other = await repository.create("另一本书");
  const proposal = await propose(repository, id, [{ operation: "create", path: "workspace/result.md", content: "result" }]);
  const writer = repository as unknown as { writeState(state: NovelState): Promise<void> };
  const original = writer.writeState.bind(repository);
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(writer, "writeState", async (state: NovelState) => { entered(); await gate; await original(state); });
  const committing = repository.applyProposal(proposal);
  await paused;
  let readerFinished = false;
  const reading = repository.get(id).then((state) => { readerFinished = true; return state; });
  try {
    assert.equal((await repository.get(other.novelId)).novelId, other.novelId);
    assert.equal(readerFinished, false);
  } finally { release(); }
  await committing;
  assert.ok((await reading).files["workspace/result.md"]);
});

for (const afterWrite of [false, true]) test(`state-write failure ${afterWrite ? "after" : "before"} replacement rolls back files and state, then the queue accepts a retry`, async (t) => {
  const { repository, id, directory } = await fixture(t);
  await repository.applyProposal(await propose(repository, id, [{ operation: "create", path: "workspace/old.md", content: "before" }]));
  const state = await repository.get(id);
  const proposal = await propose(repository, id, [
    { operation: "replace", path: "workspace/old.md", baseSha256: state.files["workspace/old.md"]!.sha256, content: "after" },
    { operation: "create", path: "workspace/new.md", content: "new" },
  ]);
  const beforeState = await readFile(path.join(directory, "novel-state.yaml"), "utf8");
  const writer = repository as unknown as { writeState(state: NovelState): Promise<void> };
  const original = writer.writeState.bind(repository);
  const stub = t.mock.method(writer, "writeState", async (next: NovelState) => { if (afterWrite) await original(next); throw new Error("injected ENOSPC"); });
  await assert.rejects(repository.applyProposal(proposal), /injected ENOSPC/);
  stub.mock.restore();
  assert.equal(await readFile(path.join(directory, "workspace/old.md"), "utf8"), "before");
  await assert.rejects(stat(path.join(directory, "workspace/new.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(directory, "novel-state.yaml"), "utf8"), beforeState);
  await assert.rejects(stat(path.join(directory, ".pending-commit.json")), { code: "ENOENT" });
  await repository.applyProposal(proposal);
  assert.equal((await repository.readProjectFile(id, "workspace/old.md")).content, "after");
});

async function interruptCommit(root: string, id: string, afterState = false) {
  const script = `
    import { NovelRepository } from ${JSON.stringify(repositoryUrl)};
    const repository = new NovelRepository(${JSON.stringify(root)});
    const proposal = await repository.prepareProposal(${JSON.stringify(id)}, { intent: "crash", summary: "crash", changes: [{ operation: "create", path: "workspace/crash.md", content: "new content" }] });
    const original = repository.writeState.bind(repository);
    repository.writeState = async (state) => { ${afterState ? "await original(state);" : ""} process.exit(73); };
    await repository.applyProposal(proposal);
  `;
  await assert.rejects(run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), windowsHide: true }), (error: unknown) => (error as { code?: number }).code === 73);
}

for (const afterState of [false, true]) test(`a fresh repository recovers a process exit ${afterState ? "after" : "before"} the state commit`, async (t) => {
  const { root, id, directory } = await fixture(t);
  await interruptCommit(root, id, afterState);
  await stat(path.join(directory, ".pending-commit.json"));
  const recovered = await new NovelRepository(root).get(id);
  if (afterState) {
    assert.equal(recovered.files["workspace/crash.md"]?.sha256, sha256("new content"));
    assert.equal(await readFile(path.join(directory, "workspace/crash.md"), "utf8"), "new content");
  } else {
    assert.equal(recovered.files["workspace/crash.md"], undefined);
    await assert.rejects(stat(path.join(directory, "workspace/crash.md")), { code: "ENOENT" });
  }
  await assert.rejects(stat(path.join(directory, ".pending-commit.json")), { code: "ENOENT" });
});

test("interrupted commit recovery preserves a subsequent external author edit", async (t) => {
  const { root, id, directory } = await fixture(t);
  await interruptCommit(root, id);
  const target = path.join(directory, "workspace/crash.md");
  await writeFile(target, "author recovered text");
  await assert.rejects(new NovelRepository(root).get(id), code("NOVEL_RECOVERY_CONFLICT"));
  assert.equal(await readFile(target, "utf8"), "author recovered text");
  await stat(path.join(directory, ".pending-commit.json"));
});

test("journal cleanup failure preserves a committed batch for later cleanup", async (t) => {
  const { root, repository, id, directory } = await fixture(t);
  const proposal = await propose(repository, id, [{ operation: "create", path: "workspace/committed.md", content: "committed" }]);
  const cleanup = repository as unknown as { removePendingCommit(novelId: string): Promise<void> };
  const stub = t.mock.method(cleanup, "removePendingCommit", async () => { throw new Error("injected cleanup failure"); });
  const applied = await repository.applyProposal(proposal);
  assert.equal(applied.duplicate, false);
  assert.equal(applied.state.files["workspace/committed.md"]?.sha256, sha256("committed"));
  await assert.rejects(repository.claimProductionJob(id, "blocked-until-journal-cleanup", { goal: "review_project", scope: {} }, "standard"), /injected cleanup failure/);
  await stat(path.join(directory, ".pending-commit.json"));
  stub.mock.restore();
  assert.equal((await new NovelRepository(root).get(id)).files["workspace/committed.md"]?.sha256, sha256("committed"));
  await assert.rejects(stat(path.join(directory, ".pending-commit.json")), { code: "ENOENT" });
});

test("recovery continues a rollback interrupted while state still contains the committed hash", async (t) => {
  const { root, id, directory } = await fixture(t);
  const script = `
    import { unlink } from "node:fs/promises";
    import path from "node:path";
    import { NovelRepository } from ${JSON.stringify(repositoryUrl)};
    const repository = new NovelRepository(${JSON.stringify(root)});
    const proposal = await repository.prepareProposal(${JSON.stringify(id)}, { intent: "crash", summary: "crash", changes: [
      { operation: "create", path: "workspace/rollback-a.md", content: "A" },
      { operation: "create", path: "workspace/rollback-b.md", content: "B" }
    ] });
    const original = repository.writeState.bind(repository);
    repository.writeState = async (state) => { await original(state); throw new Error("failure after state rename"); };
    repository.rollbackCommit = async (novelId, journal) => {
      await unlink(path.join(${JSON.stringify(directory)}, journal.files[0].path));
      process.exit(74);
    };
    await repository.applyProposal(proposal);
  `;
  await assert.rejects(run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), windowsHide: true }), (error: unknown) => (error as { code?: number }).code === 74);
  const journal = JSON.parse(await readFile(path.join(directory, ".pending-commit.json"), "utf8"));
  assert.equal(journal.phase, "rolling_back");
  const recovered = await new NovelRepository(root).get(id);
  assert.equal(recovered.files["workspace/rollback-a.md"], undefined);
  assert.equal(recovered.files["workspace/rollback-b.md"], undefined);
  assert.equal(await readFile(path.join(directory, "novel-state.yaml"), "utf8"), journal.beforeState);
  await assert.rejects(stat(path.join(directory, "workspace/rollback-b.md")), { code: "ENOENT" });
});

for (const protectedPath of ["chapters/chapter-001.md", "book/ledger.yaml"]) test(`chapter production refuses author-protected ${protectedPath}`, async (t) => {
  const { repository, id } = await fixture(t);
  const { jobId, basis } = await prepareWriting(repository, id);
  if (protectedPath.startsWith("chapters/")) await repository.commitChapter(id, { jobId, chapter: 1, text: "已验收的初稿", review: acceptedReview(), basis });
  const file = await repository.readProjectFile(id, protectedPath);
  await repository.saveAuthorFile(id, protectedPath, `${file.content}\n# 作者修订\n`, file.sha256);
  const before = await repository.get(id);
  await assert.rejects(repository.commitChapter(id, { jobId, chapter: 1, text: "AI 替换正文", review: acceptedReview(), basis: chapterBasis(before) }), code(protectedPath.startsWith("chapters/") ? "CHAPTER_SEQUENCE" : "AUTHOR_APPROVAL_REQUIRED"));
  assert.deepEqual(await repository.get(id), before);
  assert.equal((await repository.readProjectFile(id, protectedPath)).content, `${file.content}\n# 作者修订\n`);
});

test("concurrent chapter commits advance once and a canceled job cannot commit", async (t) => {
  const { repository, id } = await fixture(t);
  await prepareWriting(repository, id, "old-job");
  await repository.finishProductionJob(id, "old-job", "canceled");
  const { basis } = await prepareWriting(repository, id, "new-job");
  await assert.rejects(repository.commitChapter(id, { jobId: "old-job", chapter: 1, text: "旧任务正文", review: acceptedReview(), basis }), code("ACTIVE_JOB_CHANGED"));
  const results = await Promise.allSettled(["A", "B"].map((text) => repository.commitChapter(id, { jobId: "new-job", chapter: 1, text, review: acceptedReview(), basis })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && code("CHAPTER_SEQUENCE")(result.reason)));
  assert.equal((await repository.get(id)).nextChapter, 2);
});

test("a failed job retains retry context but its old writer can no longer commit", async (t) => {
  const { repository, id } = await fixture(t);
  const { jobId, basis } = await prepareWriting(repository, id);
  const failed = await repository.finishProductionJob(id, jobId, "failed");
  assert.equal(failed.activeJobId, jobId);
  await assert.rejects(repository.commitChapter(id, { jobId, chapter: 1, text: "延迟到达的正文", review: acceptedReview(), basis }), code("PRODUCTION_AUTHORIZATION_REVOKED"));
  assert.equal((await repository.get(id)).nextChapter, 1);
  assert.equal((await repository.get(id)).files["chapters/chapter-001.md"], undefined);
});
