import assert from "node:assert/strict";
import test from "node:test";
import { assertSkillName, normalizeSkillPath, skillBindingsSchema, skillFileSchema } from "../src/domain";

test("skill packages stay inside the supported resource roots", () => {
  assert.equal(normalizeSkillPath("SKILL.md"), "SKILL.md");
  assert.equal(normalizeSkillPath("references/人物弧.md"), "references/人物弧.md");
  assert.equal(normalizeSkillPath("scripts/check.py"), "scripts/check.py");
  assert.throws(() => normalizeSkillPath("../SKILL.md"));
  assert.throws(() => normalizeSkillPath("C:\\secret.txt"));
  assert.throws(() => normalizeSkillPath("random/readme.md"));
});

test("skill bindings keep published version choice and agent scope explicit", () => {
  const parsed = skillBindingsSchema.parse({ version: 1, skills: [{ skillId: "chapter-writing", enabled: true, version: "latest", agents: ["novel-agent"], tasks: ["chapter-writing"] }] });
  assert.equal(parsed.skills[0]?.version, "latest");
  assert.equal(parsed.skills[0]?.agents[0], "novel-agent");
  assert.equal(skillBindingsSchema.safeParse({ version: 2, skills: [] }).success, false);
});

test("skill files require matching text or binary payloads", () => {
  const digest = "a".repeat(64);
  assert.equal(skillFileSchema.safeParse({ path: "SKILL.md", kind: "text", content: "x", size: 1, sha256: digest }).success, true);
  assert.equal(skillFileSchema.safeParse({ path: "assets/a.png", kind: "binary", size: 1, sha256: digest }).success, false);
});

test("skill names are stable hyphen-case identifiers", () => {
  assertSkillName("chapter-writing-2");
  assert.throws(() => assertSkillName("Chapter Writing"));
  assert.throws(() => assertSkillName("chapter_writing"));
  assert.throws(() => assertSkillName("-chapter"));
});
