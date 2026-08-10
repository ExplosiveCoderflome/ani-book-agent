import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { Dpapi, isPlatformSupported } from "@primno/dpapi";
import { AppError } from "../src/application/errors";
import { untitledNovelTitle } from "../src/domain";
import { ModelSettingsStore, sanitizeProviderError } from "../src/infrastructure/model-settings";
import { NovelRepository, novelInputHash } from "../src/infrastructure/novel-repository";
import { normalizeProviderCatalog } from "../src/infrastructure/provider-catalog";
import { createNovelBriefWorkflow } from "../src/mastra/workflows/advance-novel-workflow";
import { promptVersion, type NovelBrief } from "../src/shared/contracts";

const brief = (hook = "主角在处刑台上收到未来自己的警告"): NovelBrief => ({
  workingTitle: "长夜归途",
  oneSentencePremise: "失去身份的少年必须在王朝崩塌前找回真相。",
  targetReaders: "喜欢成长、悬念与连续反转的读者",
  primaryReaderReward: "稳定升级和关键反转",
  protagonist: "被抹去身份、但能看见失败未来的少年",
  coreConflict: "主角必须借助敌人的秩序推翻敌人，同时避免成为新的暴君",
  storyEngine: "接受任务、结盟破局、获得新线索，再面对更高层的秩序阻力",
  openingHook: hook,
  longTermPromise: "主角将揭开历代王朝循环覆灭的原因，并决定是否终止循环",
  risks: ["力量升级可能压过人物选择", "谜团揭示需要持续给出阶段答案"],
});

test("an untitled novel adopts the approved brief title", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-untitled-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create(untitledNovelTitle);
    await repository.saveOpeningChoices(created.novelId, { channel: "男频", format: "免费连载", primaryReward: "成长升级" });
    const ready = await repository.get(created.novelId);
    const inputHash = novelInputHash(ready);
    await repository.commitBrief({
      novelId: created.novelId,
      brief: brief(),
      expectedInputHash: inputHash,
      idempotencyKey: `${created.novelId}:book:novel_brief:${inputHash}:${promptVersion}`,
    });
    assert.equal((await repository.get(created.novelId)).title, "长夜归途");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed conversational presets rename and enrich an untitled novel", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-preset-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create(untitledNovelTitle);
    const saved = await repository.saveOpeningChoices(created.novelId, {
      workingTitle: "雾城回响",
      storyDirection: "失忆巡夜人发现每次救人都会抹去一段自己的过去。",
      genre: "都市悬疑",
      tone: "克制、紧张、偶有温情",
      channel: "泛读者",
      format: "免费连载",
      primaryReward: "谜团阶段解答与人物关系反转",
    });
    assert.equal(saved.title, "雾城回响");
    assert.equal(saved.openingChoices?.genre, "都市悬疑");
    assert.match(saved.openingChoices?.storyDirection ?? "", /巡夜人/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository commits atomically, detects stale input, and protects author edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-workbench-"));
  try {
    const repository = new NovelRepository(root);
    const state = await repository.create("长夜归途");
    await repository.saveOpeningChoices(state.novelId, { channel: "男频", format: "免费连载", primaryReward: "成长升级" });
    const ready = await repository.get(state.novelId);
    const inputHash = novelInputHash(ready);
    const idempotencyKey = `${state.novelId}:book:novel_brief:${inputHash}:${promptVersion}`;
    const committed = await repository.commitBrief({ novelId: state.novelId, brief: brief(), expectedInputHash: inputHash, idempotencyKey });
    assert.equal(committed.duplicate, false);
    assert.match(await readFile(path.join(root, state.novelId, "book", "novel-brief.md"), "utf8"), /故事引擎/);

    const duplicate = await repository.commitBrief({ novelId: state.novelId, brief: brief(), expectedInputHash: inputHash, idempotencyKey });
    assert.equal(duplicate.duplicate, true);
    const edited = await repository.editCommittedBrief(state.novelId, brief("作者亲自改写的钩子"), committed.sha256);
    const protectedState = await repository.get(state.novelId);
    assert.equal(protectedState.artifacts["book:novel_brief"]?.protected, true);
    assert.equal(protectedState.artifacts["book:novel_brief"]?.userEdited, true);
    await assert.rejects(
      repository.editCommittedBrief(state.novelId, brief(), committed.sha256),
      (error: unknown) => error instanceof AppError && error.code === "ARTIFACT_CONFLICT",
    );
    assert.notEqual(edited.sha256, committed.sha256);

    await repository.saveOpeningChoices(state.novelId, { channel: "女频", format: "免费连载", primaryReward: "情感拉扯" });
    await assert.rejects(
      repository.commitBrief({ novelId: state.novelId, brief: brief(), expectedInputHash: inputHash, idempotencyKey }),
      (error: unknown) => error instanceof AppError && error.code === "CONTEXT_STALE",
    );
    await assert.rejects(repository.get("../outside"), (error: unknown) => error instanceof AppError && error.code === "NOVEL_NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DPAPI vault never writes plaintext secrets and redacts provider errors", { skip: process.platform !== "win32" || !isPlatformSupported }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-secrets-"));
  try {
    const store = new ModelSettingsStore(root);
    await store.save("test-provider", "test-model", { TEST_PROVIDER_API_KEY: "top-secret-value" });
    const persisted = await readFile(path.join(root, "secrets", "providers.json"), "utf8");
    assert.equal(persisted.includes("top-secret-value"), false);
    assert.equal((await store.runtimeSelection()).model, "test-provider/test-model");
    assert.equal(sanitizeProviderError(new Error("api_key=top-secret-value rejected")).includes("top-secret-value"), false);
    const encrypted = Dpapi.protectData(Buffer.from("round-trip", "utf8"), null, "CurrentUser");
    assert.equal(Buffer.from(Dpapi.unprotectData(encrypted, null, "CurrentUser")).toString("utf8"), "round-trip");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider catalog maps multiple credential fields and keeps the full model list", () => {
  const result = normalizeProviderCatalog({ providers: [{
    id: "custom",
    label: "自定义服务",
    envVar: ["CUSTOM_KEY", "CUSTOM_ENDPOINT"],
    models: [{ id: "model-a", name: "模型 A" }, "model-b"],
  }] }, new Set(["custom"]));
  assert.deepEqual(result[0]?.envVar, ["CUSTOM_KEY", "CUSTOM_ENDPOINT"]);
  assert.deepEqual(result[0]?.models.map((model) => model.id), ["model-a", "model-b"]);
  assert.equal(result[0]?.connected, true);
});

test("workflow can suspend again after revision feedback and only commits approval", async () => {
  let generations = 0;
  let committedHook = "";
  const workflow = createNovelBriefWorkflow({
    generateBrief: async (_input, revision) => {
      generations += 1;
      return brief(revision ? `根据意见调整：${revision.feedback}` : undefined);
    },
    commitBrief: async (input) => { committedHook = input.approvedBrief.openingHook; return { sha256: "c".repeat(64), duplicate: false }; },
  });
  new Mastra({ storage: new InMemoryStore(), workflows: { workflow } });
  const run = await workflow.createRun();
  const started = await run.start({ inputData: {
    novelId: "be279f15-921c-4ee1-b96b-5319038965c4",
    title: "长夜归途",
    openingChoices: { channel: "男频", format: "免费连载", primaryReward: "成长升级" },
    inputHash: "d".repeat(64),
    promptVersion,
  } });
  assert.equal(started.status, "suspended");
  const revised = await run.resume({ step: "review-novel-brief", resumeData: { action: "revise", feedback: "强化开篇胜利" } });
  assert.equal(revised.status, "suspended");
  assert.equal(generations, 2);
  assert.equal(committedHook, "");
  const approved = brief("作者批准的最终钩子");
  const result = await run.resume({ step: "review-novel-brief", resumeData: { action: "approve", brief: approved } });
  assert.equal(result.status, "success");
  assert.equal(committedHook, approved.openingHook);
});
