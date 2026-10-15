import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { classifyProductionError, createNovelService, workflowTimestamp } from "../src/application/novel-service";
import { newNovelState } from "../src/domain";

test("workflow timestamps accept Mastra Date values and stored strings", () => {
  const fallback = "2026-08-31T00:00:00.000Z";
  const value = new Date("2026-08-31T08:52:28.540Z");
  assert.equal(workflowTimestamp(value, fallback), "2026-08-31T08:52:28.540Z");
  assert.equal(workflowTimestamp("2026-08-31T08:52:29.000Z", fallback), "2026-08-31T08:52:29.000Z");
  assert.equal(workflowTimestamp(undefined, fallback), fallback);
});

test("production failures expose stable model error categories", () => {
  assert.equal(classifyProductionError({ status: 429 }).code, "MODEL_RATE_LIMITED");
  assert.equal(classifyProductionError({ response: { status: 503 } }).code, "MODEL_UNAVAILABLE");
  assert.equal(classifyProductionError({ cause: { code: "ETIMEDOUT" } }).code, "MODEL_TIMEOUT");
  assert.equal(classifyProductionError({ code: "MODEL_GENERATION_TIMEOUT" }).code, "MODEL_TIMEOUT");
  assert.equal(classifyProductionError({ type: "response.failed", response: { error: { code: "server_error", message: "temporary provider problem" } } }).code, "MODEL_UNAVAILABLE");
  assert.equal(classifyProductionError({ isRetryable: true }).code, "MODEL_UNAVAILABLE");
  assert.deepEqual(classifyProductionError({ statusCode: 401, message: "invalid api key" }), {
    code: "MODEL_CONFIG_INVALID", message: "模型配置、凭据或模型名称无效，请检查模型设置。", recoverable: false,
  });
  assert.deepEqual(classifyProductionError({ code: "CONTEXT_LIMIT_EXCEEDED" }), {
    code: "CONTEXT_LIMIT_EXCEEDED", message: "模型上下文超过限制，请缩短输入或拆分任务后再运行。", recoverable: false,
  });
  assert.deepEqual(classifyProductionError({ code: "CHAPTER_REJECTED", recoverable: false }, "章节验收失败"), {
    code: "CHAPTER_REJECTED", message: "章节验收失败", recoverable: false,
  });
});

test("an unreadable persisted active job blocks snapshots and new production instead of being cleared", async () => {
  const novelId = randomUUID(); const now = "2026-08-31T00:00:00.000Z";
  const state = newNovelState("单链保护", novelId, now); state.phase = "writing"; state.activeJobId = "persisted-job";
  for (const filePath of ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"]) state.files[filePath] = { sha256: "a".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now };
  let clearCalls = 0; let createCalls = 0;
  const service = createNovelService({
    novels: {
      get: async () => state, listFiles: async () => [], readLedger: async () => ({ version: 1, decisions: [], characters: [], worldRules: [], openThreads: [], continuity: [] }),
      stateHash: () => "b".repeat(64),
      finishProductionJob: async () => { clearCalls += 1; state.activeJobId = undefined; return state; },
    },
    skills: { resolveForAgent: async () => [] }, preferences: { get: async () => ({ version: 1 }) }, adaptations: { list: async () => [] },
    production: { getWorkflowRunById: async () => { throw new Error("workflow storage temporarily unavailable"); }, createRun: async () => { createCalls += 1; throw new Error("must not run"); } },
    sanitizeError: String,
  } as any);
  await assert.rejects(service.projectSnapshot(novelId), /workflow storage temporarily unavailable/);
  await assert.rejects(service.startProductionJob(novelId, { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 } }), /workflow storage temporarily unavailable/);
  assert.equal(state.activeJobId, "persisted-job");
  assert.equal(clearCalls, 0);
  assert.equal(createCalls, 0);
});

test("failed chapter jobs retry from authoritative nextChapter and preserve their mode", async () => {
  const novelId = randomUUID();
  const now = "2026-08-31T00:00:00.000Z";
  const state = newNovelState("重试测试", novelId, now);
  state.phase = "writing";
  state.nextChapter = 2;
  state.activeJobId = "old-job";
  for (const filePath of ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"]) {
    state.files[filePath] = { sha256: "a".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now };
  }
  let started: any;
  let workflowStatus = "failed";
  let workflowSteps: Record<string, unknown> | undefined;
  let claimed: any;
  const deps: any = {
    novels: {
      get: async () => state,
      stateHash: () => "b".repeat(64),
      claimProductionJob: async (_id: string, jobId: string, request: any, mode: string, options: any) => { claimed = { request, mode, options }; state.activeJobId = jobId; return state; },
      finishProductionJob: async (_id: string, jobId: string) => { if (state.activeJobId === jobId) state.activeJobId = undefined; return state; },
      adaptationSetHash: () => "c".repeat(64),
    },
    skills: { resolveForAgent: async () => [] },
    preferences: { get: async () => ({ version: 1 }) },
    adaptations: { list: async () => [] },
    production: {
      getWorkflowRunById: async () => ({
        status: workflowStatus, steps: workflowSteps, resourceId: novelId, createdAt: now, updatedAt: now, error: { message: "temporary provider failure" },
        payload: { novelId, goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 }, baseStateHash: "b".repeat(64), interactionMode: "autonomous_opening", attempt: 1 },
      }),
      createRun: async () => ({ runId: "new-job", start: async ({ inputData }: any) => { started = inputData; return { status: "running" }; }, resume: async () => ({ status: "running" }), cancel: async () => undefined }),
    },
    sanitizeError: (error: unknown) => String(error),
  };
  const service = createNovelService(deps);
  workflowStatus = "running";
  assert.equal((await service.jobView(novelId, "old-job")).cursor, 2);
  workflowStatus = "suspended";
  workflowSteps = { "run-production": { suspendPayload: { checkpoint: "chapter_review", chapter: 3 } } };
  assert.equal((await service.jobView(novelId, "old-job")).cursor, 3);
  workflowStatus = "failed";
  workflowSteps = undefined;
  assert.equal((await service.jobView(novelId, "old-job")).cursor, 2);
  await assert.rejects(
    service.startProductionJob(novelId, { goal: "write_chapters", scope: { fromChapter: 2, toChapter: 4 } }),
    (error: any) => error?.code === "FAILED_JOB_REQUIRES_ACTION",
  );
  const retried = await service.resumeJob(novelId, "old-job", { action: "retry" });
  assert.equal(retried.id, "new-job");
  assert.deepEqual(retried.scope, { fromChapter: 2, toChapter: 3 });
  assert.equal(retried.interactionMode, "autonomous_opening");
  assert.equal(retried.retryOf, "old-job");
  assert.equal(retried.attempt, 2);
  assert.equal(state.activeJobId, "new-job");
  assert.equal(started.scope.fromChapter, 2);
  assert.equal(started.scope.toChapter, 3);
  assert.equal(started.interactionMode, "autonomous_opening");
  assert.deepEqual(claimed.options, { expectedStateHash: "b".repeat(64), previousJob: { id: "old-job", status: "failed" } });
  assert.deepEqual(claimed.request.scope, { fromChapter: 2, toChapter: 3 });
});

test("automatic opening keeps its one-time mode when no production run could be created", async () => {
  const novelId = randomUUID(); const now = "2026-08-31T00:00:00.000Z";
  const state = newNovelState("启动恢复", novelId, now, "autonomous_opening"); state.phase = "writing";
  for (const filePath of ["book/blueprint.md", "book/ledger.yaml", "book/tension-curve.yaml"]) state.files[filePath] = { sha256: "a".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now };
  const service = createNovelService({
    novels: { get: async () => state, stateHash: () => "b".repeat(64) },
    skills: { resolveForAgent: async () => [] }, preferences: { get: async () => ({ version: 1 }) }, adaptations: { list: async () => [] },
    production: { createRun: async () => { throw new Error("storage temporarily unavailable"); } }, sanitizeError: String,
  } as any);
  await assert.rejects(service.startProductionJob(novelId, { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 } }), /storage temporarily unavailable/);
  assert.equal(state.approvalMode, "autonomous_opening");
  assert.equal(state.activeJobId, undefined);
});

test("resuming author confirmation commits the current plan before resuming the workflow", async () => {
  const novelId = randomUUID(); const now = "2026-08-31T00:00:00.000Z";
  const state = newNovelState("确认边界", novelId, now);
  state.activeJobId = "current-job";
  const calls: string[] = [];
  let checkpoint = "curve_confirmation";
  let confirmationError: Error | undefined;
  const service = createNovelService({
    novels: {
      get: async () => state, stateHash: () => "b".repeat(64),
      confirmProductionPlan: async (_id: string, jobId: string) => {
        assert.equal(jobId, "current-job"); calls.push("confirm");
        if (confirmationError) throw confirmationError;
        return state;
      },
    },
    production: {
      getWorkflowRunById: async () => ({ status: "suspended", resourceId: novelId, payload: { novelId, goal: "write_chapters", scope: { fromChapter: 1, toChapter: 3 } }, steps: { "run-production": { suspendPayload: { checkpoint, chapter: 1 } } } }),
      createRun: async () => ({ runId: "current-job", resume: async () => { calls.push("resume"); return { status: "suspended" }; } }),
    },
    sanitizeError: String,
  } as any);
  confirmationError = new Error("当前计划已失效");
  await assert.rejects(service.resumeJob(novelId, "current-job", { action: "continue" }), /当前计划已失效/);
  assert.deepEqual(calls, ["confirm"]);
  confirmationError = undefined; calls.length = 0;
  await service.resumeJob(novelId, "current-job", { action: "continue" });
  assert.deepEqual(calls, ["confirm", "resume"]);
  checkpoint = "chapter_review"; calls.length = 0;
  await assert.rejects(service.resumeJob(novelId, "current-job", { action: "continue" }), (error: any) => error.code === "JOB_RESTART_REQUIRED");
  assert.deepEqual(calls, []);
});

test("canceling revokes the domain grant before asking the runtime to abort", async () => {
  const novelId = randomUUID(); const state = newNovelState("取消边界", novelId);
  state.activeJobId = "current-job";
  const calls: string[] = [];
  const service = createNovelService({
    novels: {
      get: async () => state, stateHash: () => "b".repeat(64),
      finishProductionJob: async (_id: string, jobId: string, outcome: string) => {
        assert.equal(jobId, "current-job"); assert.equal(outcome, "canceled");
        calls.push("finish"); state.activeJobId = undefined; return state;
      },
    },
    production: {
      getWorkflowRunById: async () => ({ status: "running", resourceId: novelId, payload: { novelId } }),
      createRun: async () => ({ runId: "current-job", cancel: async () => { assert.equal(state.activeJobId, undefined); calls.push("cancel"); } }),
    },
    sanitizeError: String,
  } as any);
  assert.equal((await service.resumeJob(novelId, "current-job", { action: "cancel" })).status, "canceled");
  assert.deepEqual(calls, ["finish", "cancel"]);
});

test("proposal author decisions use persisted domain commands", async () => {
  const novelId = randomUUID(); const state = newNovelState("作者决策", novelId);
  const proposal = { id: randomUUID(), novelId, intent: "修订设定", summary: "更新人物档案", changes: [{ operation: "create", path: "book/characters/hero.md", content: "角色档案" }], approval: "author", status: "pending", createdAt: new Date().toISOString() };
  const calls: string[] = [];
  const service = createNovelService({
    novels: {
      approveProposal: async (value: any) => { assert.equal(value.id, proposal.id); calls.push("approve"); return { proposal: { ...value, status: "applied" }, state, duplicate: value.status === "applied" }; },
      rejectProposal: async (value: any) => { assert.deepEqual(value, proposal); calls.push("reject"); return { ...value, status: "rejected" }; },
    },
  } as any);
  assert.equal((await service.approveProposal(novelId, proposal)).proposal.status, "applied");
  assert.equal((await service.approveProposal(novelId, { ...proposal, status: "applied" })).proposal.status, "applied");
  assert.equal((await service.rejectProposal(novelId, proposal)).status, "rejected");
  assert.deepEqual(calls, ["approve", "approve", "reject"]);
});
