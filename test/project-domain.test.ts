import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { availableOperations, ledgerSchema, mergeLedger, newNovelState, normalizeNovelPath, patchApproval } from "../src/domain";

test("schema v2 accepts only whitelisted novel files", () => {
  assert.equal(normalizeNovelPath("chapters/chapter-001.md"), "chapters/chapter-001.md");
  for (const value of ["../outside.md", "chapters/../../outside.md", "/chapters/chapter-001.md", "C:\\tmp\\chapter.md", "private/secret.md", "chapters/chapter.exe"]) {
    assert.throws(() => normalizeNovelPath(value));
  }
});

test("domain protects blueprint and author-owned files", () => {
  const state = newNovelState("测试书", randomUUID());
  assert.equal(patchApproval(state, [{ operation: "create", path: "book/blueprint.md", content: "蓝图" }]), "author");
  assert.equal(patchApproval(state, [{ operation: "create", path: "book/characters/hero.md", content: "角色档案" }]), "author");
  state.files["chapters/chapter-001.md"] = { sha256: "a".repeat(64), version: 2, source: "author", protected: true, updatedAt: state.updatedAt };
  assert.equal(patchApproval(state, [{ operation: "replace", path: "chapters/chapter-001.md", baseSha256: "a".repeat(64), content: "修订" }]), "author");
});

test("availability is phase-based and one active job blocks production", () => {
  const state = newNovelState("测试书", randomUUID());
  assert.deepEqual(availableOperations(state).allowedOperations, ["propose_blueprint", "review_project"]);
  state.phase = "writing";
  assert.ok(availableOperations(state).allowedOperations.includes("write_chapters"));
  assert.ok(availableOperations(state).allowedOperations.includes("review_project"));
  const now = new Date().toISOString();
  const active = { id: "job-1", novelId: state.novelId, goal: "write_chapters" as const, scope: {}, status: "running" as const, baseStateHash: "b".repeat(64), createdAt: now, updatedAt: now };
  assert.deepEqual(availableOperations(state, active).allowedOperations, []);
  assert.equal(availableOperations(state, active).blockers[0]?.code, "ACTIVE_JOB");
});

test("ledger merge synchronizes current character facts and advances threads", () => {
  const ledger = ledgerSchema.parse({ version: 1, characters: [{ id: "hero", name: "林默", role: "学徒", goal: "求生", state: "受伤", knowledge: ["门已锁"], relationships: ["阿宁：敌对"] }], openThreads: [{ id: "door", kind: "mystery", text: "门后是谁", status: "open", introducedChapter: 1, lastAdvancedChapter: 1 }] });
  const merged = mergeLedger(ledger, 2, { characterUpdates: [{ id: "hero", role: "守炉人", goal: "护送阿宁", state: "脱险", knowledge: ["门已锁", "钥匙在钟里"], relationships: ["阿宁：暂时同盟"] }], worldRules: [], threads: [{ id: "door", kind: "mystery", text: "门后是谁", status: "advanced" }], changes: ["主角离开旧宅"] });
  assert.deepEqual(merged.characters[0]?.knowledge, ["门已锁", "钥匙在钟里"]);
  assert.equal(merged.characters[0]?.role, "守炉人");
  assert.equal(merged.characters[0]?.goal, "护送阿宁");
  assert.deepEqual(merged.characters[0]?.relationships, ["阿宁：暂时同盟"]);
  assert.equal(merged.openThreads[0]?.lastAdvancedChapter, 2);
  assert.deepEqual(merged.continuity[0], { chapter: 2, changes: ["主角离开旧宅"] });
});
