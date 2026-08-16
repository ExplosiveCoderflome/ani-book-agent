import assert from "node:assert/strict";
import test from "node:test";
import { artifactKey, bookStages, type NovelState } from "../src/domain";
import { buildWorkspaceProjection } from "../src/application/workspace-projection";
import type { ArtifactProposal, RunView } from "../src/shared/contracts";

function state(): NovelState {
  return { schemaVersion: 2, novelId: "novel-1", title: "测试小说", currentChapter: 1, approvedChapterEnd: 0, productionMode: "multi_volume", currentVolume: 1, volumes: {}, productionStatus: "in_progress", artifacts: {} };
}

function readyPlanning(value: NovelState) {
  value.openingChoices = { channel: "泛读者", format: "连载", primaryReward: "成长" };
  for (const stage of bookStages.filter((item) => item !== "volume_outline")) value.artifacts[artifactKey(stage)] = { stage, status: "ready", path: `${stage}.md`, protected: false };
}

test("workspace projection keeps discovery in the real conversation", () => {
  const projection = buildWorkspaceProjection(state());
  assert.equal(projection.phase, "discovery");
  assert.deepEqual(projection.focus, { kind: "conversation", title: "说出你的故事" });
  assert.equal(projection.production[0]?.status, "pending");
});

test("workspace projection derives planning, volume and chapter phases from domain next action", () => {
  const value = state();
  value.openingChoices = { channel: "泛读者", format: "连载", primaryReward: "成长" };
  assert.equal(buildWorkspaceProjection(value).phase, "planning");
  readyPlanning(value);
  assert.equal(buildWorkspaceProjection(value).phase, "volume");
  value.volumes["1"] = { number: 1, startChapter: 1, endChapter: 10, final: false, status: "active" };
  value.artifacts["volume:1:outline"] = { stage: "volume_outline", status: "ready", path: "volume.md", protected: false };
  assert.equal(buildWorkspaceProjection(value).phase, "chapter");
});

test("workspace focus priority is failed, review, running, then domain action", () => {
  const value = state();
  readyPlanning(value);
  value.activeRunId = "run-1";
  const proposal: ArtifactProposal = { artifactKey: "book:novel_brief", title: "小说简报", format: "markdown", content: "# 内容", files: [], metadata: {} };
  const base: RunView = { runId: "run-1", novelId: value.novelId, workflowId: "novel-brief", status: "running", executionStatus: "running", attempt: 1, recovered: false };
  assert.equal(buildWorkspaceProjection(value, base).focus.kind, "generation");
  assert.equal(buildWorkspaceProjection(value, { ...base, status: "awaiting_review", executionStatus: "suspended", artifactProposal: proposal }).focus.kind, "review");
  assert.equal(buildWorkspaceProjection(value, { ...base, status: "failed", executionStatus: "failed", error: { code: "FAILED", message: "失败", recoverable: true } }).focus.kind, "blocked");
});

test("workspace ignores a run that is not the novel authoritative active run", () => {
  const value = state();
  readyPlanning(value);
  value.activeRunId = "run-2";
  const projection = buildWorkspaceProjection(value, { runId: "run-1", novelId: value.novelId, status: "running", executionStatus: "running", attempt: 1, recovered: false });
  assert.equal(projection.run, undefined);
  assert.equal(projection.focus.kind, "next_action");
});
