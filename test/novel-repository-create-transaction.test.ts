import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NovelRepository } from "../src/infrastructure/novel-repository";

for (const failure of ["before", "after"] as const) {
  test(`creation uses the common transaction and rolls back a state failure ${failure} replacement`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ani-create-transaction-"));
    try {
      const repository = new NovelRepository(root);
      const internal = repository as any;
      const writeState = internal.writeState.bind(repository);
      let failedId = "";
      internal.writeState = async (state: { novelId: string }) => {
        failedId = state.novelId;
        if (failure === "after") await writeState(state);
        throw new Error("injected initial state failure");
      };
      await assert.rejects(repository.create("未完成的新书"), /injected initial state failure/);
      for (const file of ["novel-state.yaml", "workspace/ideas.md", ".pending-commit.json"]) {
        await assert.rejects(readFile(path.join(root, failedId, file)), { code: "ENOENT" });
      }
      assert.deepEqual(await repository.list(), []);
      internal.writeState = writeState;
      const created = await repository.create("可以重试");
      assert.equal((await repository.get(created.novelId)).title, "可以重试");
    } finally {
      assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  });
}
