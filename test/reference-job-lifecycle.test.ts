import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AppError } from "../src/application/errors";
import { createReferenceService } from "../src/application/reference-service";
import type { RuntimeRunState, WorkflowRunnerPort } from "../src/application/ports";
import { referenceAnalysisSchema, type ReferenceState } from "../src/domain";
import { estimateDeconstruction, referenceChaptersInRange, ReferenceRepository } from "../src/infrastructure/reference-repository";
import { createReferenceDeconstructionWorkflow, DECONSTRUCTION_PROMPT_VERSION } from "../src/mastra/workflows/reference-deconstruction-workflow";

const isCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "ani-reference-jobs-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new ReferenceRepository(root);
  const imported = await repository.import({ fileName: "audit.txt", bytes: Buffer.from("第一章 出发\n第一章内容。\n第二章 相遇\n第二章内容。\n第三章 归来\n第三章内容。") });
  const { state } = await repository.confirmManifest(imported.state.referenceId, imported.state.manifestHash);
  return { repository, state, root };
}
function analysis(state: ReferenceState, id: string) {
  const timestamp = new Date().toISOString();
  return referenceAnalysisSchema.parse({ id, mode: "standard", preset: "quick", sectionKeys: ["overview"], focuses: [], status: "running", sourceHash: state.source.sha256, manifestHash: state.manifestHash, promptVersion: DECONSTRUCTION_PROMPT_VERSION, tokenBudget: 1_000_000, createdAt: timestamp, updatedAt: timestamp });
}
function service(repository: ReferenceRepository, production: WorkflowRunnerPort) {
  return createReferenceService({
    references: repository, deconstruction: production, characters: production,
    models: { runtimeSelection: async () => ({ parameters: {} }) } as any,
    chapterPattern: { suggest: async () => { throw new Error("not used"); } },
    estimator: { estimate: estimateDeconstruction, chapters: referenceChaptersInRange },
    sanitizeError: String, promptVersion: DECONSTRUCTION_PROMPT_VERSION, newId: randomUUID,
  });
}

test("parallel requests reserve the reference library before awaiting its current job", async (t) => {
  const { repository, state } = await fixture(t);
  let started = 0;
  const runner: WorkflowRunnerPort = {
    createRun: async () => ({ runId: randomUUID(), start: async () => { started += 1; return { status: "running" }; }, resume: async () => ({ status: "running" }), cancel: async () => undefined }),
    getWorkflowRunById: async () => null,
  };
  const app = service(repository, runner);
  const input = { manifestHash: state.manifestHash, tokenBudget: 1_000_000 };
  const results = await Promise.allSettled([app.startReferenceJob(state.referenceId, input), app.startReferenceJob(state.referenceId, input)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.ok(rejected?.status === "rejected" && isCode("REFERENCE_JOB_ACTIVE")(rejected.reason));
  assert.equal(started, 1);
  assert.equal((await repository.get(state.referenceId)).analyses.length, 1);
});

test("library claims are exclusive across repository instances", async (t) => {
  const { repository, state, root } = await fixture(t);
  const other = new ReferenceRepository(process.platform === "win32" ? root.toUpperCase() : root);
  const results = await Promise.allSettled([
    repository.claimJob(state.referenceId, "job-a", analysis(state, "analysis-a")),
    other.claimJob(state.referenceId, "job-b", analysis(state, "analysis-b")),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.ok(rejected?.status === "rejected" && isCode("REFERENCE_JOB_ACTIVE")(rejected.reason));
  assert.equal((await repository.get(state.referenceId)).analyses.length, 1);
});

test("cancel waits for an in-flight guarded write and rejects every later old-owner mutation", async (t) => {
  const { repository, state, root } = await fixture(t);
  const other = new ReferenceRepository(root);
  await repository.claimJob(state.referenceId, "job-a", analysis(state, "analysis-a"));
  const checked = gate();
  const release = gate();
  const assertOwner = repository.assertActiveJob.bind(repository);
  repository.assertActiveJob = async (referenceId, jobId) => { await assertOwner(referenceId, jobId); checked.resolve(); await release.promise; };
  const writing = repository.writeAnalysisFile(state.referenceId, "analysis-a", "batches/batch-1.yaml", "before cancel", "job-a");
  await checked.promise;
  let canceled = false;
  const canceling = other.finishJob(state.referenceId, "job-a", "analysis-a", { status: "canceled" }).then((result) => { canceled = true; return result; });
  const newJob = other.claimJob(state.referenceId, "job-b", analysis(state, "analysis-b"));
  await new Promise((done) => setImmediate(done));
  assert.equal(canceled, false, "owner check and write must share the cancellation critical section");
  release.resolve();
  await writing;
  assert.equal(await canceling, true);
  await newJob;
  await assert.rejects(other.writeAnalysisFile(state.referenceId, "analysis-a", "index.yaml", "late write", "job-a"), isCode("REFERENCE_JOB_INACTIVE"));
  await assert.rejects(other.updateAnalysis(state.referenceId, analysis(state, "analysis-a"), "job-a"), isCode("REFERENCE_JOB_INACTIVE"));
  assert.equal(await other.finishJob(state.referenceId, "job-a", "analysis-a", { status: "completed" }), false);
  assert.equal(await other.clearActiveJob(state.referenceId, "job-a"), false);
  assert.equal((await other.libraryState()).activeJobId, "job-b");
  assert.equal((await other.get(state.referenceId)).analyses.find((item) => item.id === "analysis-a")?.status, "canceled");
});

test("canceling the real finalization step aborts its model and cannot publish or clear a new job", async (t) => {
  const { repository, state } = await fixture(t);
  const current = analysis(state, "analysis-a");
  await repository.claimJob(state.referenceId, "job-a", current);
  const entered = gate<AbortSignal>();
  const release = gate();
  const workflow = createReferenceDeconstructionWorkflow({
    references: repository,
    models: { runtimeSelection: async () => ({ parameters: {} }) } as any,
    estimator: { estimate: estimateDeconstruction, chapters: referenceChaptersInRange },
    deconstructionAgent: { generate: async (_prompt, options) => {
      entered.resolve(options.abortSignal);
      await release.promise; // Deliberately ignore cancellation to emulate a late provider response.
      return { object: { summary: "总结", content: "内容", structuredData: {}, insights: [], dimensions: [], characterCandidates: [], evidence: [] } };
    } },
  });
  const controller = new AbortController();
  const running = workflow.steps["finalize-reference-analysis"]!.execute({
    inputData: [], runId: "job-a", abortSignal: controller.signal,
    getInitData: () => ({ referenceId: state.referenceId, jobId: "job-a", analysisId: current.id, sourceHash: state.source.sha256, manifestHash: state.manifestHash, mode: "standard", preset: "quick", focuses: [], tokenBudget: 1_000_000, promptVersion: DECONSTRUCTION_PROMPT_VERSION }),
    suspend: async () => { throw new Error("unexpected suspension"); },
  } as any);
  const rejected = assert.rejects(running, (error: Error) => error.name === "AbortError");
  const providerSignal = await entered.promise;
  await repository.finishJob(state.referenceId, "job-a", current.id, { status: "canceled" });
  controller.abort();
  await repository.claimJob(state.referenceId, "job-b", analysis(state, "analysis-b"));
  release.resolve();
  await rejected;
  assert.equal(providerSignal.aborted, true);
  await assert.rejects(repository.readAnalysisFile(state.referenceId, current.id, "sections/overview.yaml"), isCode("REFERENCE_ANALYSIS_NOT_FOUND"));
  await assert.rejects(repository.readAnalysisFile(state.referenceId, current.id, "index.yaml"), isCode("REFERENCE_ANALYSIS_NOT_FOUND"));
  assert.equal((await repository.get(state.referenceId)).analyses.find((item) => item.id === current.id)?.status, "canceled");
  assert.equal((await repository.libraryState()).activeJobId, "job-b");
});

test("cancel and late failure views for an old run preserve the new library owner", async (t) => {
  const { repository, state } = await fixture(t);
  await repository.claimJob(state.referenceId, "job-a", analysis(state, "analysis-a"));
  await repository.finishJob(state.referenceId, "job-a", "analysis-a", { status: "canceled" });
  await repository.claimJob(state.referenceId, "job-b", analysis(state, "analysis-b"));
  const runState: RuntimeRunState = { status: "failed", payload: { referenceId: state.referenceId, analysisId: "analysis-a" }, steps: {} };
  const runner: WorkflowRunnerPort = {
    getWorkflowRunById: async () => runState,
    createRun: async () => ({ runId: "job-a", start: async () => undefined, resume: async () => ({ status: "running" }), cancel: async () => undefined }),
  };
  await service(repository, runner).referenceJobAction(state.referenceId, "job-a", { action: "cancel" });
  assert.equal((await repository.libraryState()).activeJobId, "job-b");
});

test("missing runtime state cannot silently release an authoritative active job", async (t) => {
  const { repository, state } = await fixture(t);
  await repository.claimJob(state.referenceId, "job-a", analysis(state, "analysis-a"));
  const runner: WorkflowRunnerPort = { getWorkflowRunById: async () => null, createRun: async () => { throw new Error("must not start"); } };
  await assert.rejects(service(repository, runner).startReferenceJob(state.referenceId, { manifestHash: state.manifestHash, tokenBudget: 1_000_000 }), isCode("REFERENCE_JOB_NOT_FOUND"));
  assert.equal((await repository.libraryState()).activeJobId, "job-a");
});

test("parser validation cannot overwrite state after a new job claims the reference", async (t) => {
  const { repository, state } = await fixture(t);
  const parser = await repository.parser(state.referenceId);
  const source = repository.source.bind(repository);
  const entered = gate();
  const release = gate();
  repository.source = async (id) => { const text = await source(id); entered.resolve(); await release.promise; return text; };
  const saving = assert.rejects(repository.saveParser(state.referenceId, parser), isCode("REFERENCE_ACTIVE"));
  await entered.promise;
  await repository.claimJob(state.referenceId, "job-a", analysis(state, "analysis-a"));
  release.resolve();
  await saving;
  await assert.rejects(repository.rebuildManifest(state.referenceId), isCode("REFERENCE_ACTIVE"));
  await assert.rejects(repository.confirmManifest(state.referenceId, state.manifestHash), isCode("REFERENCE_ACTIVE"));
  assert.equal((await repository.get(state.referenceId)).analyses[0]?.id, "analysis-a");
  assert.equal((await repository.libraryState()).activeJobId, "job-a");
});

test("a job claim revalidates the manifest read before its asynchronous preparation", async (t) => {
  const { repository, state } = await fixture(t);
  await assert.rejects(repository.claimJob(state.referenceId, "job-a", { ...analysis(state, "analysis-a"), manifestHash: "0".repeat(64) }), isCode("REFERENCE_MANIFEST_STALE"));
  assert.equal((await repository.libraryState()).activeJobId, undefined);
  assert.deepEqual((await repository.get(state.referenceId)).analyses, []);
});
