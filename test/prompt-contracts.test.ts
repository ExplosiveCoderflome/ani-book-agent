import assert from "node:assert/strict";
import test from "node:test";
import { promptBlockDefaults } from "../src/mastra/prompts/prompt-blocks";

const prompt = (id: string) => {
  const item = promptBlockDefaults.find((candidate) => candidate.id === id);
  assert.ok(item, `missing prompt ${id}`);
  return item.content;
};

test("all production prompts use unique v2 assets with explicit authority boundaries", () => {
  assert.equal(promptBlockDefaults.length, 16);
  assert.equal(new Set(promptBlockDefaults.map((item) => item.id)).size, promptBlockDefaults.length);
  for (const item of promptBlockDefaults) {
    assert.match(item.id, /@v2$/);
    assert.match(item.content, /作者本轮明确要求/);
    assert.ok(item.content.length >= 500, `${item.id} is too shallow`);
  }
});

test("chat choice prompt preserves finite options as complete clickable replies", () => {
  const content = prompt("novel.chat_choices@v2");
  assert.match(content, /原回复有四个方向时必须输出四项/);
  assert.match(content, /不能只写序号/);
  assert.match(content, /否则输出空数组/);
});

test("chapter prompts share an executable reader-experience and repair contract", () => {
  const plan = prompt("novel.chapter_plan@v2");
  for (const field of ["promisedReward", "protagonistWant", "primaryResistance", "keyTurn", "netChange", "endingHook", "must hit now", "must preserve", "forbidden crossings"]) assert.match(plan, new RegExp(field));

  const writer = prompt("novel.chapter_writer@v2");
  assert.match(writer, /优先承接旧钩子/);
  assert.match(writer, /主角必须主动/);
  assert.match(writer, /只输出正文/);

  const review = prompt("novel.chapter_review@v2");
  for (const verdict of ["accepted", "continue_with_warning", "local_patch_plan", "rewrite_needed", "stop_for_replan"]) assert.match(review, new RegExp(verdict));
  assert.match(review, /具体 evidence/);
  assert.match(review, /qualityDebt/);

  const repair = prompt("novel.chapter_repair@v2");
  assert.match(repair, /完整可替换的最终章节/);
  assert.match(repair, /能局部解决时只改相关段落/);
});

test("continuity extraction separates authoritative fact categories", () => {
  const content = prompt("novel.continuity_extract@v2");
  for (const field of ["facts", "characterStates", "resources", "relationships", "payoffs", "worldChanges"]) assert.match(content, new RegExp(field));
  assert.match(content, /计划、愿望、威胁、传闻、假设、梦境、谎言、未证实推断和审查建议都不是事实/);
});

test("completion and volume handoff prompts define bounded end-to-end checks", () => {
  assert.match(prompt("novel.volume_handoff@v2"), /不可逆变化/);
  assert.match(prompt("novel.volume_handoff@v2"), /下一卷入口/);
  assert.match(prompt("novel.completion_audit@v2"), /verdict=pass/);
  assert.match(prompt("novel.completion_audit@v2"), /missingChapters/);
});
