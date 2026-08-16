import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { ProductionReceiptStore } from "../src/infrastructure/production-receipt-store";
import { createNovelBriefWorkflow } from "../src/mastra/workflows/advance-novel-workflow";
import { promptVersion, type NovelBrief } from "../src/shared/contracts";

const brief: NovelBrief = {
  workingTitle: "重启测试", oneSentencePremise: "一句话故事", targetReaders: "长篇读者", primaryReaderReward: "成长",
  protagonist: "一名少年", coreConflict: "夺回故乡", storyEngine: "升级并揭开真相", openingHook: "收到未来警告", longTermPromise: "结束循环", risks: ["节奏"],
};

test("Mastra remains authoritative for persisted suspend, reload and resume", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ani-novel-mastra-run-"));
  const url = pathToFileURL(path.join(root, "mastra.db")).href;
  const novelId = "52ac4f1c-1e7f-4a50-a0bd-c71475d23ddb";
  const stores: LibSQLStore[] = [];
  try {
    const firstWorkflow = createNovelBriefWorkflow({ generateBrief: async () => brief, commitBrief: async () => ({ sha256: "a".repeat(64), duplicate: false }) });
    const firstStore = new LibSQLStore({ id: "runtime-first", url }); stores.push(firstStore);
    new Mastra({ storage: firstStore, workflows: { firstWorkflow } });
    const firstRun = await firstWorkflow.createRun({ resourceId: novelId });
    const inputData = { novelId, title: "重启测试", openingChoices: { channel: "泛读者", format: "连载", primaryReward: "成长" }, inputHash: "b".repeat(64), promptVersion };
    assert.equal((await firstRun.start({ inputData })).status, "suspended");

    let committed = false;
    const restoredWorkflow = createNovelBriefWorkflow({ generateBrief: async () => brief, commitBrief: async () => { committed = true; return { sha256: "c".repeat(64), duplicate: false }; } });
    const restoredStore = new LibSQLStore({ id: "runtime-restored", url }); stores.push(restoredStore);
    new Mastra({ storage: restoredStore, workflows: { restoredWorkflow } });
    const snapshot = await restoredWorkflow.getWorkflowRunById(firstRun.runId, { fields: ["steps", "payload"] });
    assert.equal(snapshot?.status, "suspended");
    const restoredRun = await restoredWorkflow.createRun({ runId: firstRun.runId, resourceId: novelId });
    const result = await restoredRun.resume({ step: "review-novel-brief", resumeData: { action: "approve", brief } });
    assert.equal(result.status, "success");
    assert.equal(committed, true);
  } finally {
    await Promise.all(stores.map((store) => store.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});

test("application persistence keeps immutable idempotency receipts only", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ani-novel-receipt-"));
  const store = new ProductionReceiptStore(path.join(root, "receipts.sqlite3"));
  try {
    const receipt = { idempotencyKey: "request-1", novelId: "novel-1", workflowRunId: "run-1", createdAt: "2026-08-15T00:00:00.000Z" };
    assert.deepEqual(store.record(receipt), receipt);
    assert.deepEqual(store.record({ ...receipt, workflowRunId: "run-2" }), receipt);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
