import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parse, stringify } from "yaml";
import type { NovelState, PatchProposal } from "../src/domain/project";
import { contentHash, decideNovelCommand, NovelPolicyError, proposalPath, type NovelCommand } from "../src/domain/novel-commands";
import { acceptedReview, chapterBasis, openingChanges, planningChanges } from "./novel-test-fixture";

const now = "2026-10-15T00:00:00.000Z";
function harness() {
  let state: NovelState | undefined;
  const contents: Record<string, string | undefined> = {};
  const execute = (command: NovelCommand) => {
    const before = structuredClone(state);
    const filesBefore = structuredClone(contents);
    const decision = decideNovelCommand(state, command, { now, contents });
    assert.deepEqual(state, before, "domain decisions must not mutate their input state");
    assert.deepEqual(contents, filesBefore, "domain decisions must not mutate content input");
    state = decision.state;
    for (const change of decision.changes) contents[change.path] = change.content;
    return decision;
  };
  execute({ type: "create", novelId: randomUUID(), title: "领域边界", approvalMode: "milestone" });
  const proposal = (changes: PatchProposal["changes"]) => execute({ type: "prepare_proposal", proposal: { id: randomUUID(), novelId: state!.novelId, intent: "调整", summary: "待确认调整", changes, status: "pending", approval: "auto", createdAt: now } }).proposal!;
  const open = () => execute({ type: "approve_proposal", proposal: proposal(openingChanges()) });
  const claim = (jobId = "job") => execute({ type: "claim_job", jobId, request: { goal: "write_chapters", scope: { fromChapter: state!.nextChapter, toChapter: 3 } }, interactionMode: "standard" });
  const plan = (jobId = "job") => {
    const changes = planningChanges(3);
    const curve = parse(changes[1]!.content);
    curve.basis.blueprintSha256 = state!.files["book/blueprint.md"]!.sha256;
    curve.basis.bookCurveSha256 = state!.files["book/tension-curve.yaml"]!.sha256;
    changes[1]!.content = stringify(curve);
    return execute({ type: "commit_plan", jobId, changes, basis: chapterBasis(state!) });
  };
  return { execute, proposal, open, claim, plan, contents, get state() { return state!; } };
}
const code = (expected: string) => (error: unknown) => error instanceof NovelPolicyError && error.code === expected;

test("registered proposal payload and rejection are authoritative; exact applied replay is idempotent", () => {
  const h = harness();
  const proposal = h.proposal([{ operation: "create", path: "workspace/note.md", content: "原始内容" }]);
  assert.equal(parse(h.contents[proposalPath(proposal.id)]!).status, "pending");
  assert.throws(() => h.execute({ type: "approve_proposal", proposal: { ...proposal, changes: [{ ...proposal.changes[0]!, content: "偷偷换稿" }] } }), code("PROPOSAL_CHANGED"));
  h.execute({ type: "reject_proposal", proposal });
  assert.equal(parse(h.contents[proposalPath(proposal.id)]!).status, "rejected");
  assert.throws(() => h.execute({ type: "approve_proposal", proposal }), code("PROPOSAL_NOT_PENDING"));
  const accepted = h.proposal([{ operation: "create", path: "workspace/note.md", content: "新的稿件" }]);
  h.execute({ type: "apply_proposal", proposal: accepted });
  const prior = structuredClone(h.state);
  assert.equal(h.execute({ type: "apply_proposal", proposal: accepted }).duplicate, true);
  assert.deepEqual(h.state, prior);
  const compacted = { ...h.state, appliedProposalIds: [] };
  assert.equal(decideNovelCommand(compacted, { type: "apply_proposal", proposal: accepted }, { now, contents: h.contents }).duplicate, true, "persisted receipt remains authoritative after the recent-id cache is pruned");
});

test("generic commands cannot publish chapters or alter internal decisions", () => {
  const h = harness();
  for (const path of ["chapters/chapter-001.md", "workspace/proposals/fake.yaml", "workspace/references/adaptations/fake.yaml", "workspace/analysis/volume-001-tension-actual.yaml", "workspace/reviews/fake.md"]) {
    assert.throws(() => h.proposal([{ operation: "create", path, content: "越权写入" }]), code(path.startsWith("chapters/") ? "CHAPTER_COMMIT_REQUIRED" : "INTERNAL_FILE_READ_ONLY"));
  }
  assert.equal(h.state.nextChapter, 1);
});

test("writing ledger changes require the author action regardless of unprotected source", () => {
  const h = harness(); h.open();
  const path = "book/ledger.yaml";
  const proposal = h.proposal([{ operation: "replace", path, baseSha256: h.state.files[path]!.sha256, content: "version: 1\ndecisions: [{id: fake, text: 伪造决定, source: author}]\n" }]);
  assert.equal(proposal.approval, "author");
  assert.throws(() => h.execute({ type: "apply_proposal", proposal }), code("AUTHOR_APPROVAL_REQUIRED"));
});

test("chapter submission requires current owner, accepted critic, plan consent and complete read hashes", () => {
  const h = harness(); h.open(); h.claim(); h.plan();
  const input = { jobId: "job", chapter: 1, text: "主角发现证据。", review: acceptedReview(), basis: chapterBasis(h.state) };
  assert.throws(() => h.execute({ type: "commit_chapter", input: { ...input, jobId: "other" } }), code("ACTIVE_JOB_CHANGED"));
  assert.throws(() => h.execute({ type: "commit_chapter", input: { ...input, review: acceptedReview({ verdict: "repair" }) } }), code("CHAPTER_NOT_ACCEPTED"));
  assert.throws(() => h.execute({ type: "commit_chapter", input }), code("PLAN_CONFIRMATION_REQUIRED"));
  h.execute({ type: "confirm_plan", jobId: "job" });
  assert.throws(() => h.execute({ type: "commit_chapter", input: { ...input, basis: {} } }), code("FILE_STALE"));
  const result = h.execute({ type: "commit_chapter", input });
  assert.equal(result.state.nextChapter, 2);
  assert.equal(result.changes.some((change) => change.path.endsWith("tension-actual.yaml")), true);
  assert.throws(() => h.execute({ type: "commit_chapter", input }), code("CHAPTER_SEQUENCE"));
});

test("author edits invalidate plan consent and protected ledger blocks production", () => {
  const h = harness(); h.open(); h.claim(); h.plan(); h.execute({ type: "confirm_plan", jobId: "job" });
  const plan = "volumes/volume-001.md";
  h.execute({ type: "author_edit", path: plan, content: h.contents[plan]! + "\n作者新增要求", expectedSha256: h.state.files[plan]!.sha256 });
  assert.equal(h.state.productionAuthorization?.confirmedPlan, undefined);
  assert.throws(() => h.execute({ type: "confirm_plan", jobId: "job" }), code("PRODUCTION_PLAN_STALE"));

  const other = harness(); other.open(); other.claim(); other.plan(); other.execute({ type: "confirm_plan", jobId: "job" });
  const ledger = "book/ledger.yaml";
  other.execute({ type: "author_edit", path: ledger, content: other.contents[ledger]!, expectedSha256: other.state.files[ledger]!.sha256 });
  assert.throws(() => other.execute({ type: "commit_chapter", input: { jobId: "job", chapter: 1, text: "主角发现证据。", review: acceptedReview(), basis: chapterBasis(other.state) } }), code("AUTHOR_APPROVAL_REQUIRED"));
});

test("plan generation rejects stale authority before replacing its declared basis", () => {
  const h = harness(); h.open(); h.claim();
  assert.throws(() => h.execute({ type: "commit_plan", jobId: "job", changes: planningChanges(3), basis: chapterBasis(h.state) }), code("FILE_STALE"));
  assert.equal(h.state.files["volumes/volume-001.md"], undefined);
  h.plan();
  const plan = "volumes/volume-001.md";
  assert.throws(() => h.execute({ type: "commit_plan", jobId: "job", changes: [{ operation: "replace", path: plan, content: "# 改写作者章节卡", baseSha256: h.state.files[plan]!.sha256 }], basis: chapterBasis(h.state) }), code("AUTHOR_CONTENT_CHANGED"));
});

test("failed owner remains visible but loses every production permission", () => {
  const h = harness(); h.open(); h.claim(); h.plan();
  h.execute({ type: "finish_job", jobId: "job", outcome: "failed" });
  assert.equal(h.state.activeJobId, "job");
  assert.equal(h.state.productionAuthorization?.revoked, true);
  assert.throws(() => h.execute({ type: "confirm_plan", jobId: "job" }), code("PRODUCTION_AUTHORIZATION_REVOKED"));
  assert.throws(() => h.execute({ type: "commit_chapter", input: { jobId: "job", chapter: 1, text: "正文", review: acceptedReview(), basis: chapterBasis(h.state) } }), code("PRODUCTION_AUTHORIZATION_REVOKED"));
  h.execute({ type: "claim_job", jobId: "retry", request: { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 } }, interactionMode: "standard", options: { previousJob: { id: "job", status: "failed" } } });
  h.execute({ type: "finish_job", jobId: "job", outcome: "canceled" });
  assert.equal(h.state.activeJobId, "retry");
  assert.equal(h.state.productionAuthorization?.revoked, false);
});

test("missing legacy grants and untracked author files fail closed", () => {
  const h = harness(); h.open();
  const legacy = structuredClone(h.state); legacy.activeJobId = "old";
  assert.throws(() => decideNovelCommand(legacy, { type: "claim_job", jobId: "new", request: { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 } }, interactionMode: "standard", options: { previousJob: { id: "old", status: "failed" } } }, { now, contents: h.contents }), code("PRODUCTION_AUTHORIZATION_REQUIRED"));
  h.contents["workspace/draft.md"] = "作者外部新建";
  assert.throws(() => h.proposal([{ operation: "create", path: "workspace/draft.md", content: "AI稿" }]), code("FILE_EXISTS"));
  assert.equal(contentHash(h.contents["workspace/draft.md"]!), contentHash("作者外部新建"));
});
