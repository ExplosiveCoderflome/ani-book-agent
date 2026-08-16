import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NovelRepository, novelInputHash } from "../src/infrastructure/novel-repository";
import { readSelectedNovelContext } from "../src/application/context-assembler";

test("asset projection exposes artifact dependencies and workspace files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-assets-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("资产测试");
    await repository.writeWorkspaceFile(created.novelId, "references/seed.md", "灵感");
    await mkdir(path.join(root, created.novelId, "continuity"), { recursive: true });
    await writeFile(path.join(root, created.novelId, "continuity", "index.sqlite3"), Buffer.from([0, 1, 2]));
    const state = await repository.get(created.novelId);
    const inputHash = novelInputHash(state);
    await repository.commitProposal({ novelId: created.novelId, proposal: { artifactKey: "book:novel_brief", title: "小说简报", format: "markdown", content: "简报", files: [{ path: "book/novel-brief.md", content: "简报" }], metadata: {} }, expectedInputHash: inputHash, promptVersion: "test@v1", idempotencyKey: `${created.novelId}:book:novel_brief:${inputHash}:test@v1`, dependsOn: [] });
    const assets = await repository.listAssets(created.novelId);
    assert.equal(assets.find((asset) => asset.id === "book:novel_brief")?.type, "brief");
    assert.equal(assets.find((asset) => asset.id === "workspace:references/seed.md")?.type, "workspace");
    const files = await repository.listNovelFiles(created.novelId);
    assert.ok(files.some((file) => file.path === "novel-state.yaml"));
    assert.equal(files.find((file) => file.path === "workspace/references/seed.md")?.kind, "markdown");
    assert.equal(files.find((file) => file.path === "continuity/index.sqlite3")?.kind, "binary");
    assert.equal((await repository.readNovelFile(created.novelId, "workspace/references/seed.md")).content, "灵感");
    await assert.rejects(() => repository.readNovelFile(created.novelId, "../outside.md"), /路径无效/);
    await assert.rejects(() => repository.readNovelFile(created.novelId, "continuity/index.sqlite3"), /不是可直接阅读/);
    const artifactContext = await readSelectedNovelContext(repository, created.novelId, { artifactKey: "book:novel_brief" });
    const fileContext = await readSelectedNovelContext(repository, created.novelId, { filePath: "workspace/references/seed.md" });
    assert.match(artifactContext?.content ?? "", /简报/);
    assert.equal(fileContext?.content, "灵感");
  } finally { await rm(root, { recursive: true, force: true }); }
});
