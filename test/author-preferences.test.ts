import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthorPreferenceRepository } from "../src/infrastructure/author-preference-repository";

const novelId = "11111111-1111-4111-8111-111111111111";

test("explicit choices and feedback persist as bounded YAML prompt context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-preferences-"));
  try {
    const repository = new AuthorPreferenceRepository(root);
    await repository.record({ novelId, kind: "choice", value: "智斗破局", scope: "global", messageId: "taste" });
    await repository.record({ novelId, kind: "like", value: "喜欢这次回复", excerpt: "主角依靠专业判断破局。", scope: "novel", messageId: "answer-1" });
    await repository.record({ novelId, kind: "dislike", value: "不喜欢这次回复", excerpt: "系统连续发布签到任务。", scope: "novel", messageId: "answer-1" });

    const profile = await repository.get();
    assert.equal(profile.signals.some((item) => item.kind === "like" && item.messageId === "answer-1"), false);
    assert.equal(profile.signals.some((item) => item.kind === "dislike" && item.messageId === "answer-1"), true);
    assert.match(await repository.prompt(novelId), /长期·选择.*智斗破局/);
    assert.match(await repository.prompt(novelId), /本书·不喜欢.*签到任务/);
    assert.match(await readFile(path.join(root, "default", "author-preferences.yaml"), "utf8"), /schemaVersion: 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
