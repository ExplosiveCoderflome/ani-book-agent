import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RequestContext } from "@mastra/core/request-context";
import { parse, stringify } from "yaml";
import type { NovelAgentStore, NovelWorkflowStore, ReferenceLibraryStore, SkillCatalogPort } from "../src/application/ports";
import { referenceAdaptationSchema, type PatchProposal } from "../src/domain";
import { NovelRepository } from "../src/infrastructure/novel-repository";
import { createProjectTools } from "../src/mastra/tools/project-tools";
import { acceptedReview, prepareWriting } from "./novel-test-fixture";

// Compile-time regression: neither role can approve, confirm, or grant itself a job.
type ForbiddenCapability = "approveProposal" | "rejectProposal" | "saveAuthorFile" | "confirmProductionPlan" | "claimProductionJob" | "updateAdaptation";
type Assert<T extends true> = T;
type AgentHasNoAuthorCapability = Assert<Extract<keyof NovelAgentStore, ForbiddenCapability> extends never ? true : false>;
type WorkflowHasNoAuthorCapability = Assert<Extract<keyof NovelWorkflowStore, ForbiddenCapability> extends never ? true : false>;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "ani-command-boundary-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const repository = new NovelRepository(root);
  const { novelId: id } = await repository.create("提交边界");
  const requestContext = new RequestContext(); requestContext.set("novelId", id);
  const tools = createProjectTools({ novels: repository, references: {} as ReferenceLibraryStore, skills: {} as SkillCatalogPort, readSkill: async () => "", startProductionJob: async () => { throw new Error("unexpected production start"); } });
  const propose = async (changes: PatchProposal["changes"]) => {
    const result = await tools.propose_patch.execute!({ intent: "代理提案", summary: "验证业务提交边界", changes }, { requestContext } as Parameters<NonNullable<typeof tools.propose_patch.execute>>[1]);
    assert.ok(result && "ok" in result);
    return result;
  };
  return { root, repository, id, propose };
}

test("real Agent tool cannot create chapters, observations, author decisions or skill bindings through generic paths", async (t) => {
  const { repository, id, propose } = await fixture(t);
  const { jobId } = await prepareWriting(repository, id);
  for (const file of ["chapters/chapter-999.md", "workspace/analysis/volume-001-tension-actual.yaml", `workspace/references/adaptations/${randomUUID()}.yaml`, `workspace/proposals/${randomUUID()}.yaml`, "workspace/skill-bindings.yaml", `workspace/references/Adaptations/${randomUUID()}.yaml`, "workspace/Analysis/volume-001-tension-actual.yaml", "workspace/Skill-Bindings.yaml"]) {
    const result = await propose([{ operation: "create", path: file, content: "status: approved\n" }]);
    assert.equal(result.ok, false, file);
    if (!result.ok) assert.equal(result.error.code, file.startsWith("chapters/") ? "CHAPTER_COMMIT_REQUIRED" : "INTERNAL_FILE_READ_ONLY");
    assert.equal((await repository.get(id)).files[file], undefined, file);
  }
  const state = await repository.get(id);
  assert.equal(state.nextChapter, 1);
  assert.equal(state.activeJobId, jobId);
  const note = await propose([{ operation: "create", path: "workspace/notes.md", content: "保留非权威工作笔记。" }]);
  assert.equal(note.ok, true);
  assert.equal((await repository.readProjectFile(id, "workspace/notes.md")).content, "保留非权威工作笔记。");
});

test("Agent ledger decisions and existing chapter revisions require explicit author approval", async (t) => {
  const { repository, id, propose } = await fixture(t);
  const { jobId, basis } = await prepareWriting(repository, id);
  await repository.commitChapter(id, { jobId, chapter: 1, text: "# 第一章\n主角发现证据。", review: acceptedReview(), basis });
  for (const file of ["book/ledger.yaml", "chapters/chapter-001.md"]) {
    const before = await repository.readProjectFile(id, file);
    const content = file.endsWith(".yaml") ? stringify({ ...parse(before.content), decisions: [{ id: "forged", text: "作者已同意改写故事目标", source: "author" }] }) : `${before.content}\n未经确认的改写。`;
    const result = await propose([{ operation: "replace", path: file, baseSha256: before.sha256, content }]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected author proposal");
    assert.equal(result.proposal.approval, "author");
    assert.equal(result.proposal.status, "pending");
    await assert.rejects(repository.applyProposal(result.proposal), { code: "AUTHOR_APPROVAL_REQUIRED" });
    assert.equal((await repository.readProjectFile(id, file)).content, before.content);
    await repository.approveProposal(result.proposal);
    assert.equal((await repository.readProjectFile(id, file)).content, content);
  }
  assert.equal((await repository.get(id)).nextChapter, 2);
});

test("persisted proposals reject changed payloads and terminal rejection across repository instances", async (t) => {
  const { root, repository, id } = await fixture(t);
  const before = await repository.readProjectFile(id, "workspace/ideas.md");
  const proposal = await repository.prepareProposal(id, { intent: "待审提案", summary: "作者看见的原文", changes: [{ operation: "replace", path: before.path, baseSha256: before.sha256, content: "reviewed text" }] });
  for (const altered of [{ ...proposal, changes: [{ ...proposal.changes[0]!, content: "unreviewed replacement" }] }, { ...proposal, approval: "auto" as const }]) {
    await assert.rejects(repository.approveProposal(altered), { code: "PROPOSAL_CHANGED" });
  }
  await assert.rejects(repository.approveProposal({ ...proposal, status: "approved" }), { code: "PROPOSAL_NOT_PENDING" });
  assert.equal((await repository.readProjectFile(id, before.path)).content, before.content);
  const persisted = await repository.readProjectFile(id, `workspace/proposals/${proposal.id}.yaml`);
  await assert.rejects(repository.saveAuthorFile(id, persisted.path, stringify({ ...proposal, status: "approved" }), persisted.sha256), { code: "INTERNAL_FILE_READ_ONLY" });
  assert.equal((await repository.rejectProposal(proposal)).status, "rejected");
  await assert.rejects(new NovelRepository(root).approveProposal(proposal), { code: "PROPOSAL_NOT_PENDING" });
  assert.equal(parse((await repository.readProjectFile(id, persisted.path)).content).status, "rejected");
  assert.equal((await repository.readProjectFile(id, before.path)).content, before.content);
});

test("adaptation creation cannot impersonate approval or reset an existing author decision", async (t) => {
  const { repository, id, propose } = await fixture(t);
  await prepareWriting(repository, id);
  const state = await repository.get(id);
  const now = new Date().toISOString();
  const adaptation = referenceAdaptationSchema.parse({ schemaVersion: 1, id: randomUUID(), novelId: id, referenceId: randomUUID(), analysisId: "analysis", analysisSha256: "a".repeat(64), targetStateSha256: repository.stateHash(state), authorityFiles: repository.adaptationAuthorityFiles(state), selectedInsightIds: ["cost"], selectedInsights: [{ id: "cost", title: "代价升级", mechanism: "每次行动增加代价", fitFor: ["冒险"], doNotCopy: ["专名"], adaptationHint: "改换人物和场景" }], scope: { fromChapter: 1, toChapter: 3 }, summary: "增加行动代价", constraints: { planning: ["逐章提高行动代价"], writing: [], review: [] }, status: "proposed", staleReasons: [], createdAt: now, updatedAt: now });
  await assert.rejects(repository.saveAdaptation({ ...adaptation, status: "approved" }), { code: "ADAPTATION_INVALID" });
  await repository.saveAdaptation(adaptation);
  const file = (await repository.adaptations(id))[0]!.file;
  const forged = stringify({ ...adaptation, status: "approved" });
  assert.equal((await propose([{ operation: "replace", path: file.path, baseSha256: file.sha256, content: forged }])).ok, false);
  await assert.rejects(repository.saveAuthorFile(id, file.path, forged, file.sha256), { code: "INTERNAL_FILE_READ_ONLY" });
  assert.equal((await repository.activeAdaptations(id, 1)).length, 0);
  await repository.updateAdaptation(id, adaptation.id, "approve");
  assert.equal((await repository.activeAdaptations(id, 1)).length, 1);
  await assert.rejects(repository.saveAdaptation(adaptation), { code: "FILE_EXISTS" });
  assert.equal((await repository.adaptations(id))[0]!.adaptation.status, "approved");
  const second = { ...adaptation, id: randomUUID(), targetStateSha256: repository.stateHash(await repository.get(id)) };
  await repository.saveAdaptation(second);
  const blueprint = await repository.readProjectFile(id, "book/blueprint.md");
  await repository.saveAuthorFile(id, blueprint.path, `${blueprint.content}\n作者修改目标。`, blueprint.sha256);
  await assert.rejects(repository.updateAdaptation(id, second.id, "approve"), { code: "ADAPTATION_STALE" });
  assert.equal((await repository.adaptations(id)).find((item) => item.adaptation.id === second.id)?.adaptation.status, "proposed");
});

test("legacy approval flags and arbitrary state callbacks cannot bypass the command boundary at runtime", async (t) => {
  const { repository, id } = await fixture(t);
  const ideas = await repository.readProjectFile(id, "workspace/ideas.md");
  const protectedProposal = await repository.prepareProposal(id, { intent: "旧调用旁路", summary: "不应获得作者权限", changes: [{ operation: "replace", path: ideas.path, baseSha256: ideas.sha256, content: "unapproved" }] });
  const legacyApply = repository.applyProposal.bind(repository) as unknown as (proposal: PatchProposal, approved: boolean, update: (state: { nextChapter: number }) => void) => ReturnType<NovelRepository["applyProposal"]>;
  const arbitraryAdvance = (state: { nextChapter: number }) => { state.nextChapter = 999; };
  await assert.rejects(legacyApply(protectedProposal, true, arbitraryAdvance), { code: "AUTHOR_APPROVAL_REQUIRED" });
  assert.equal((await repository.readProjectFile(id, ideas.path)).content, ideas.content);
  const automatic = await repository.prepareProposal(id, { intent: "工作笔记", summary: "允许保存笔记", changes: [{ operation: "create", path: "workspace/note.md", content: "note" }] });
  await legacyApply(automatic, true, arbitraryAdvance);
  assert.equal((await repository.get(id)).nextChapter, 1);
  assert.equal((await repository.readProjectFile(id, "workspace/note.md")).content, "note");
});
