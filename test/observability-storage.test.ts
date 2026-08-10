import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DuckDBStore } from "@mastra/duckdb";

test("local observability storage supports Studio logs and discovery queries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-observability-"));
  const store = new DuckDBStore({ path: path.join(root, "observability.duckdb"), memoryLimit: "128MB", threads: 1 });
  try {
    await store.observability.init();
    const [logs, entities] = await Promise.all([
      store.observability.listLogs({}),
      store.observability.getEntityNames({}),
    ]);
    assert.ok(Array.isArray(logs.logs));
    assert.deepEqual(entities.names, []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
