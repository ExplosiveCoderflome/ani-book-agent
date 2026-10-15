import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { executionEnvelopeSchema } from "../src/domain";
import { NovelRepository } from "../src/infrastructure/novel-repository";
import { bindSkillCatalog } from "../src/mastra/skill-loader";
import { createNovelProductionWorkflow, productionWorkflowInputSchema } from "../src/mastra/workflows/novel-production-workflow";
import { acceptedReview, openingChanges, planningChanges } from "./novel-test-fixture";

test("the production step uses the commit boundary for planning consent, accepted chapters and late cancellation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-production-boundary-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const novels = new NovelRepository(root);
  bindSkillCatalog({ version: async () => ({ files: [{ path: "SKILL.md", kind: "text", content: "遵守当前章节计划和验收要求。" }] }) } as any);
  let planningCalls = 0;
  let proseCalls = 0;
  let planningTo = 1;
  let verdict: "accepted" | "repair" = "accepted";
  let waitForWriter: (() => Promise<void>) | undefined;
  const workflow = createNovelProductionWorkflow({
    novels,
    models: { runtimeSelection: async () => ({ parameters: {} }) } as any,
    novelAgent: { generate: async (_prompt, options) => {
      if (options.requestContext.get("stage") === "planning") {
        planningCalls += 1;
        const changes = planningChanges(planningTo);
        return { object: { plan: changes[0]!.content + "\n场景要求：" + "用具体行动展现主角的目标、阻力和选择。".repeat(12), curve: parse(changes[1]!.content) } };
      }
      proseCalls += 1;
      await waitForWriter?.();
      return { text: "# 第一章\n\n主角发现证据，决定立即追上失踪的同伴。" };
    } },
    novelCritic: { generate: async () => ({ object: acceptedReview({ verdict }) }) },
  });
  const step = workflow.steps["run-production"]!;
  async function start(jobId: string, autonomous = false) {
    const novel = await novels.create(jobId, autonomous ? "autonomous_opening" : "milestone");
    const changes = openingChanges();
    if (autonomous) changes.push({ operation: "create", path: "book/characters/hero.md", content: "# 主角\n\n- 外貌与辨识特征：左眉有旧伤，常穿深灰短衣。\n- 叙事功能：主动推动调查并承担关键选择。\n- 外在目标：查清同伴失踪的真相。\n- 内在需要：重新学会信任别人。\n- 核心矛盾：想独自解决危险，却必须接受他人的帮助。\n" });
    const proposal = await novels.prepareProposal(novel.novelId, { intent: "开书", summary: "确认开书", changes });
    if (autonomous) await novels.applyProposal(proposal);
    else await novels.approveProposal(proposal);
    const interactionMode = autonomous ? "autonomous_opening" : "standard";
    const scope = { fromChapter: 1, toChapter: autonomous ? 3 : 1 };
    const state = await novels.claimProductionJob(novel.novelId, jobId, { goal: "write_chapters", scope }, interactionMode);
    const baseStateHash = novels.stateHash(state);
    const execution = executionEnvelopeSchema.parse({ schemaVersion: 1, runId: jobId, traceId: jobId, novelId: novel.novelId, taskType: "write_chapters", stage: "planning", novelStateHash: baseStateHash, preferenceVersion: 0, skillVersions: {}, allowedTools: [], requiresApproval: true, contextBudget: 32_000 });
    return productionWorkflowInputSchema.parse({ novelId: novel.novelId, jobId, goal: "write_chapters", scope, interactionMode, baseStateHash, execution, tensionCurveRequired: true });
  }
  const execute = (inputData: ReturnType<typeof productionWorkflowInputSchema.parse>, resume = false, signal = new AbortController().signal) => step.execute({
    inputData, runId: inputData.jobId, abortSignal: signal,
    ...(resume ? { resumeData: { action: "continue" } } : {}),
    suspend: async (payload: unknown) => ({ suspended: payload }),
  } as any);

  await t.test("standard planning saves for review, then preserves an author-edited curve through chapter commit", async () => {
    const input = await start("standard-job");
    const paused = await execute(input) as any;
    assert.equal(paused.suspended.checkpoint, "curve_confirmation");
    assert.equal(proseCalls, 0);
    assert.equal((await novels.get(input.novelId)).productionAuthorization?.confirmedPlan, undefined);
    const file = await novels.readProjectFile(input.novelId, "volumes/volume-001-tension.yaml");
    const curve = parse(file.content);
    curve.points[0].tension = 73;
    const authorCurve = await novels.saveAuthorFile(input.novelId, file.path, stringify(curve), file.sha256);
    await novels.confirmProductionPlan(input.novelId, input.jobId);
    const completed = await execute(input, true) as any;
    assert.equal(completed.status, "completed");
    const state = await novels.get(input.novelId);
    assert.equal(state.nextChapter, 2);
    assert.equal(state.activeJobId, undefined);
    assert.equal(state.files[file.path]!.sha256, authorCurve.sha256);
    assert.equal((await novels.readLedger(input.novelId)).continuity[0]?.chapter, 1);
    assert.equal(planningCalls, 1);
    assert.equal(proseCalls, 1);
  });

  await t.test("a draft that still fails review never becomes a stable chapter", async () => {
    const input = await start("rejected-job");
    await execute(input);
    await novels.confirmProductionPlan(input.novelId, input.jobId);
    verdict = "repair";
    await assert.rejects(execute(input, true), /仍未通过独立验收/);
    const state = await novels.get(input.novelId);
    assert.equal(state.nextChapter, 1);
    assert.equal(state.files["chapters/chapter-001.md"], undefined);
    assert.equal(state.activeJobId, input.jobId);
    verdict = "accepted";
  });

  await t.test("a late writer response cannot commit or finish a replacement job", async () => {
    const input = await start("canceled-job");
    await execute(input);
    await novels.confirmProductionPlan(input.novelId, input.jobId);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    waitForWriter = async () => { entered(); await released; };
    const controller = new AbortController();
    const running = execute(input, true, controller.signal);
    const rejected = assert.rejects(running, (error: Error) => error.name === "AbortError");
    await enteredPromise;
    await novels.finishProductionJob(input.novelId, input.jobId, "canceled");
    controller.abort();
    await novels.claimProductionJob(input.novelId, "replacement", { goal: "write_chapters", scope: { fromChapter: 1, toChapter: 1 } }, "standard");
    release();
    await rejected;
    waitForWriter = undefined;
    const state = await novels.get(input.novelId);
    assert.equal(state.activeJobId, "replacement");
    assert.equal(state.nextChapter, 1);
    assert.equal(state.files["chapters/chapter-001.md"], undefined);
  });

  await t.test("explicit autonomous opening completes three chapters without granting manual author approval", async () => {
    planningTo = 3;
    const input = await start("autonomous-job", true);
    const completed = await execute(input) as any;
    assert.equal(completed.status, "completed");
    const state = await novels.get(input.novelId);
    assert.equal(state.nextChapter, 4);
    assert.equal(state.approvalMode, "milestone");
    assert.equal(state.productionAuthorization, undefined);
    assert.equal((await novels.readLedger(input.novelId)).continuity.length, 3);
  });
});
