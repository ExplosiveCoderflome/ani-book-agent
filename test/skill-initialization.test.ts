import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RequestContext } from "@mastra/core/request-context";
import { LibSQLStore } from "@mastra/libsql";
import { stringify } from "yaml";
import { NovelRepository } from "../src/infrastructure/novel-repository";
import { SkillRegistryService } from "../src/infrastructure/skill-registry";
import { ModelSettingsStore } from "../src/infrastructure/model-settings";
import { AuthorPreferenceRepository } from "../src/infrastructure/author-preference-repository";
import { createNovelAgents } from "../src/mastra/agents/novel-agent";
import { createNovelSkillWorkspaceFactory } from "../src/mastra/workspace/novel-skill-workspace";

test("first autonomous chat initializes skills once without weakening opening approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-skill-initialization-"));
  const storage = new LibSQLStore({ id: "skill-initialization-test", url: ":memory:" });
  try {
    const novels = new NovelRepository(root);
    const novel = await novels.create("首次全自动开书", "autonomous_opening");
    const skills = new SkillRegistryService(novels, storage.stores.skills!, storage.stores.blobs!);
    const { novelAgent } = createNovelAgents({
      novels,
      models: new ModelSettingsStore(path.join(root, "settings")),
      preferences: new AuthorPreferenceRepository(path.join(root, "preferences")),
      projectTools: {},
      loadCorePrompt: async () => "测试首次聊天的工作区初始化。",
      readSkill: async () => "测试方法。",
      workspace: createNovelSkillWorkspaceFactory(skills, storage.stores.blobs!),
    });
    const requestContext = new RequestContext();
    requestContext.set("novelId", novel.novelId);
    requestContext.set("taskType", "chat");
    const [workspace, criticSkills] = await Promise.all([
      novelAgent.getWorkspace({ requestContext }),
      skills.resolveForAgent(novel.novelId, "novel-critic"),
    ]);
    assert.ok(workspace);
    assert.equal(criticSkills.length, 7);
    const initialized = await novels.readProjectFile(novel.novelId, "workspace/skill-bindings.yaml");
    assert.equal(initialized.version, 1);
    assert.equal(initialized.source, "author");
    assert.equal(initialized.protected, true);
    const state = await novels.get(novel.novelId);
    assert.equal(state.phase, "discovery");
    assert.equal(state.nextChapter, 1);
    assert.equal(state.approvalMode, "autonomous_opening");
    await assert.rejects(novels.prepareProposal(novel.novelId, {
      intent: "不完整开书", summary: "只有蓝图", changes: [{ operation: "create", path: "book/blueprint.md", content: "# 蓝图" }],
    }), { code: "AUTONOMOUS_OPENING_INVALID" });

    const bindings = await skills.bindings(novel.novelId);
    await assert.rejects(novels.saveAuthorFile(novel.novelId, initialized.path, "skills: invalid\n", initialized.sha256), { code: "SKILL_BINDINGS_INVALID" });
    assert.equal((await novels.readProjectFile(novel.novelId, initialized.path)).sha256, initialized.sha256);
    bindings.skills[0]!.enabled = false;
    const authored = await novels.saveAuthorFile(novel.novelId, initialized.path, stringify(bindings), initialized.sha256);
    const reread = await Promise.all([skills.bindings(novel.novelId), skills.bindings(novel.novelId)]);
    assert.ok(reread.every((value) => value.skills[0]!.enabled === false));
    assert.equal((await novels.readProjectFile(novel.novelId, initialized.path)).sha256, authored.sha256);
  } finally {
    await storage.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
