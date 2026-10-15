import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { AppError } from "../src/application/errors";
import { NovelRepository, novelStateHash } from "../src/infrastructure/novel-repository";
import { acceptedReview, prepareWriting } from "./novel-test-fixture";

const ledger = "version: 1\ndecisions: []\ncharacters: []\nworldRules: []\nopenThreads: []\ncontinuity: []\n";
const heroProfile = "# 林默\n\n> 角色 ID：hero\n\n- 叙事功能：主动推动主线并承担关键选择。\n- 外在目标：查清城中异变并保护同伴。\n- 内在需要：学会相信他人。\n- 核心矛盾：必须合作，却习惯独自承担风险。\n- 外貌与辨识特征：眉骨有一道旧伤，常穿深灰短衣，思考时会轻敲刀鞘。\n- 行为与声音：说话直接，先行动再解释。\n";
const bookCurve = stringify({ schemaVersion: 1, kind: "book", title: "全书张力", basis: { blueprintSha256: "0".repeat(64), generatedAt: "2026-08-25T00:00:00.000Z" }, calibration: { status: "aligned", reasons: [] }, points: [
  { id: "opening", progress: 0, label: "开篇", tension: 30, emotion: { kind: "curiosity", intensity: 2 }, function: "hook", rationale: "建立问题", source: "ai", locked: false },
  { id: "ending", progress: 100, label: "终局", tension: 92, emotion: { kind: "exhilaration", intensity: 5 }, function: "climax", rationale: "完成总兑现", source: "ai", locked: false },
], }, { lineWidth: 0 });
const isCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test("repository auto-applies only a complete autonomous opening bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-auto-opening-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("全自动开书", "autonomous_opening");
    assert.equal(created.approvalMode, "autonomous_opening");
    await assert.rejects(() => repository.prepareProposal(created.novelId, {
      intent: "不完整开书", summary: "缺少角色档案", changes: [
        { operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" },
        { operation: "create", path: "book/ledger.yaml", content: ledger },
        { operation: "create", path: "book/tension-curve.yaml", content: bookCurve },
      ],
    }), isCode("AUTONOMOUS_OPENING_INVALID"));
    const proposal = await repository.prepareProposal(created.novelId, {
      intent: "全自动开书", summary: "完整开书资产", changes: [
        { operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" },
        { operation: "create", path: "book/ledger.yaml", content: ledger },
        { operation: "create", path: "book/tension-curve.yaml", content: bookCurve },
        { operation: "create", path: "book/characters/hero.md", content: heroProfile },
      ],
    });
    assert.equal(proposal.approval, "auto");
    const applied = await repository.applyProposal(proposal);
    assert.equal(applied.state.phase, "writing");
    assert.equal(applied.state.files["book/characters/hero.md"]?.source, "agent");
    assert.equal((await repository.applyProposal(proposal)).duplicate, true);
    assert.equal((await repository.cancelAutonomousOpening(created.novelId)).approvalMode, "milestone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository enforces hashes, approval, protection, serial chapters and export", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-v2-"));
  try {
    const repository = new NovelRepository(root);
    const created = await repository.create("边界测试");
    assert.equal(novelStateHash(created), novelStateHash(Object.fromEntries(Object.entries(created).reverse()) as typeof created));
    assert.equal((await repository.readProjectFile(created.novelId, "workspace/ideas.md")).protected, true);
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "越权", summary: "越权", changes: [{ operation: "create", path: "../outside.md", content: "x" }] }), isCode("INVALID_NOVEL_PATH"));
    await assert.rejects(
      () => repository.prepareProposal(created.novelId, { intent: "错误账本", summary: "错误账本", changes: [{ operation: "create", path: "book/ledger.yaml", content: "version: 1\ndecisions:\n  - id: d1\n    topic: 错误字段\n" }] }),
      (error: unknown) => error instanceof AppError && error.code === "LEDGER_INVALID" && error.message.includes("decisions.0.text"),
    );
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "半份开书", summary: "只有蓝图", changes: [{ operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" }] }), isCode("LEDGER_REQUIRED"));
    await assert.rejects(
      () => repository.prepareProposal(created.novelId, { intent: "缺少外貌", summary: "创建不完整角色", changes: [{ operation: "create", path: "book/characters/hero.md", content: "# 主角\n\n> 角色 ID：hero\n\n- 叙事功能：负责主动调查真相并推动主线。\n- 外在目标：查清失踪案并保全自己。\n- 行为与声音：冷静果断，遇事先观察再行动。\n" }] }),
      isCode("CHARACTER_PROFILE_INVALID"),
    );

    const opening = await repository.prepareProposal(created.novelId, {
      intent: "确认开书",
      summary: "写入蓝图、账本和张力曲线",
      changes: [
        { operation: "create", path: "book/blueprint.md", content: "# 蓝图\n" },
        { operation: "create", path: "book/ledger.yaml", content: ledger },
        { operation: "create", path: "book/tension-curve.yaml", content: bookCurve },
      ],
    });
    assert.equal(opening.approval, "author");
    await assert.rejects(() => repository.applyProposal(opening), isCode("AUTHOR_APPROVAL_REQUIRED"));
    const applied = await repository.approveProposal(opening);
    assert.equal(applied.state.phase, "writing");
    assert.equal((await repository.approveProposal(opening)).duplicate, true);

    const blueprint = await repository.readProjectFile(created.novelId, "book/blueprint.md");
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "无哈希", summary: "无哈希", changes: [{ operation: "replace", path: blueprint.path, content: "新蓝图" }] }), isCode("BASE_HASH_REQUIRED"));
    await assert.rejects(() => repository.prepareProposal(created.novelId, { intent: "旧哈希", summary: "旧哈希", changes: [{ operation: "replace", path: blueprint.path, baseSha256: "0".repeat(64), content: "新蓝图" }] }), isCode("FILE_STALE"));

    const { jobId, basis } = await prepareWriting(repository, created.novelId);
    await assert.rejects(() => repository.commitChapter(created.novelId, { jobId, chapter: 2, text: "# 第二章", review: acceptedReview(), basis }), isCode("CHAPTER_SEQUENCE"));
    await repository.commitChapter(created.novelId, { jobId, chapter: 1, text: "# 第一章\n正文", basis, review: acceptedReview({ continuityDelta: { characterUpdates: [{ id: "guide", name: "阿宁", role: "向导", goal: "带主角过河", state: "已经同行", knowledge: [], relationships: ["主角：临时同伴"] }], worldRules: [], threads: [{ id: "promise", kind: "promise", text: "找到故乡", status: "open" }], changes: ["主角离村"] }, newCharacterProfiles: [{ id: "guide", content: "# 阿宁\n\n> 角色 ID：guide\n\n- 叙事功能：带领主角进入陌生地域，并持续制造信任压力。\n- 外在目标：完成过河交易。\n- 内在需要：重新学会信任同行者。\n- 核心矛盾：需要主角合作，却不愿暴露真实来历。\n- 外貌与辨识特征：身形清瘦，常戴旧斗笠，右手虎口留有一道渡河绳磨出的白痕。\n- 行为与声音：说话简短，先谈条件再提供帮助。\n- 人物弧检查点：近期决定是否履行约定。\n" }] }) });
    assert.match((await repository.readProjectFile(created.novelId, "book/characters/guide.md")).content, /角色 ID：guide/);
    const chapter = await repository.readProjectFile(created.novelId, "chapters/chapter-001.md");
    const saved = await repository.saveAuthorFile(created.novelId, chapter.path, `${chapter.content}\n作者修改`, chapter.sha256);
    assert.equal(saved.source, "author");
    assert.equal(saved.protected, true);
    const protectedPatch = await repository.prepareProposal(created.novelId, { intent: "修改正文", summary: "修改正文", changes: [{ operation: "replace", path: saved.path, baseSha256: saved.sha256, content: `${saved.content}\nAgent 修改` }] });
    assert.equal(protectedPatch.approval, "author");
    await assert.rejects(() => repository.applyProposal(protectedPatch), isCode("AUTHOR_APPROVAL_REQUIRED"));

    await assert.rejects(() => repository.claimProductionJob(created.novelId, "job-2", { goal: "review_project", scope: {} }, "standard"), isCode("ACTIVE_JOB"));
    assert.equal((await repository.finishProductionJob(created.novelId, "other-job", "completed")).activeJobId, jobId);
    await repository.finishProductionJob(created.novelId, jobId, "completed");

    await repository.claimProductionJob(created.novelId, "export-job", { goal: "export", scope: {} }, "standard");
    const exported = await repository.exportNovel(created.novelId, "export-job");
    assert.equal(exported.chapterCount, 1);
    assert.match(exported.content, /第一章/);
    assert.equal((await repository.readProjectFile(created.novelId, exported.path)).content, exported.content);

    const beforeExternalEdit = await repository.prepareProposal(created.novelId, { intent: "修改蓝图", summary: "修改蓝图", changes: [{ operation: "replace", path: blueprint.path, baseSha256: blueprint.sha256, content: "# Agent 新蓝图\n" }] });
    const blueprintPath = path.join(root, created.novelId, "book", "blueprint.md");
    await writeFile(blueprintPath, "# 作者在本地改过的蓝图\n", "utf8");
    await assert.rejects(() => repository.approveProposal(beforeExternalEdit), isCode("FILE_STALE"));
    const reconciled = await repository.readProjectFile(created.novelId, "book/blueprint.md");
    assert.equal(reconciled.source, "author");
    assert.equal(reconciled.protected, true);
    assert.equal(reconciled.version, blueprint.version + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
