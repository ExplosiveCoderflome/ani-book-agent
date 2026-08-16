import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { workbenchApiRoutes } from "../src/mastra/workbench-api";
import { hasRenderableMessage, messageForDisplay, openingPresetFromMessage, resolveToolLifecycle } from "../src/web/studio/MessageParts";
import { currentActionRunRequest } from "../src/application/workbench-service";
import { renderOpeningPresetPrompt } from "../src/mastra/prompts/opening-preset";

const routeNames = workbenchApiRoutes.map((route) => `${route.method} ${route.path}`);

test("workspace projection endpoint is additive and keeps the legacy novel endpoint", () => {
  assert.ok(routeNames.includes("GET /workbench-api/novels/:id"));
  assert.ok(routeNames.includes("GET /workbench-api/novels/:id/workspace"));
  assert.ok(routeNames.includes("GET /workbench-api/novels/:id/assets"));
  assert.ok(routeNames.includes("GET /workbench-api/novels/:id/files"));
  assert.ok(routeNames.includes("GET /workbench-api/novels/:id/files/content"));
  assert.ok(routeNames.includes("PUT /workbench-api/novels/:id/workspace-files"));
  assert.ok(routeNames.includes("GET /workbench-api/observability/stats"));
  assert.equal(routeNames.includes("POST /workbench-api/novels/:id/chat"), false);
  assert.equal(routeNames.includes("POST /workbench-api/novels/:id/chat-choices"), false);
});

test("conversation renders real messages without workflow assistant bubbles", () => {
  const source = readFileSync(new URL("../src/web/Conversation.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/web/workbench/NovelWorkbench.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("flowNode"), false);
  assert.equal(source.includes('name: "workflow"'), false);
  assert.equal(source.includes("WorkflowDataPart"), false);
  assert.equal(source.includes("创作搭档"), false);
  assert.equal(shell.includes("创作搭档"), false);
  assert.equal(source.includes("StudioMessage"), true);
  assert.equal(source.includes("type=\"file\""), true);
  assert.equal(shell.includes("NovelFileManager"), true);
  assert.equal(shell.includes("onUseAsContext"), true);
  assert.equal(shell.includes("CodeBlock"), true);
});

test("studio message filtering drops empty parts but keeps real status and tool parts", () => {
  const empty = { id: "empty", role: "assistant", content: { parts: [{ type: "reasoning", text: "" }] } } as never;
  const pending = { id: "pending", role: "assistant", content: { metadata: { status: "error" }, parts: [] } } as never;
  const tool = { id: "tool", role: "assistant", content: { parts: [{ type: "dynamic-tool", toolName: "read_novel_artifact", toolCallId: "call-1", state: "input-available", input: {} }] } } as never;
  assert.equal(hasRenderableMessage(empty), false);
  assert.equal(hasRenderableMessage(pending), true);
  assert.equal(hasRenderableMessage(tool), true);
});

test("thread signal user messages render as user messages after history recovery", () => {
  const signal = { id: "signal-user", role: "signal", content: { metadata: { signal: { type: "user" } }, parts: [{ type: "text", text: "我的创作想法" }] } } as never;
  assert.equal(hasRenderableMessage(signal), true);
  assert.equal(messageForDisplay(signal).role, "user");
});

test("chat can only start the server-selected artifact workflow", () => {
  assert.deepEqual(currentActionRunRequest({ type: "produce_artifact", stage: "novel_brief", artifactKey: "book:novel_brief", workflowId: "novel-brief", reason: "生成小说简报" }), { workflowId: "novel-brief", target: undefined });
  assert.deepEqual(currentActionRunRequest({ type: "produce_artifact", stage: "chapter_plan", artifactKey: "chapter:7:chapter_plan", workflowId: "chapter-planning", reason: "生成章节计划" }), { workflowId: "chapter-planning", target: "7" });
  assert.throws(() => currentActionRunRequest({ type: "collect_opening_choices", reason: "仍需确认开书预设" }));
});

test("opening preset preparation includes persisted thread signal user messages", () => {
  const prompt = renderOpeningPresetPrompt("测试作品", [{ id: "signal", role: "signal", content: { metadata: { signal: { type: "user" } }, parts: [{ type: "text", text: "我想写一部都市悬疑" }] } } as never]);
  assert.match(prompt, /作者：我想写一部都市悬疑/);
});

test("opening preset tool output is promoted into the editable workbench proposal", () => {
  const proposal = { workingTitle: "雾港来信", storyDirection: "记者追查失踪案并发现家族秘密", genre: "都市悬疑", tone: "冷峻克制", channel: "女频", format: "长篇连载", primaryReward: "线索反转", rationale: "承接作者确认的调查主线。" };
  const message = { id: "preset", role: "assistant", content: { parts: [{ type: "tool-invocation", toolInvocation: { toolName: "prepareOpeningPresetTool", result: proposal } }] } } as never;
  assert.deepEqual(openingPresetFromMessage(message), proposal);
});

test("studio tool parts close cleanly after output, approval, or interrupted streams", () => {
  assert.equal(resolveToolLifecycle({ state: "output-available", output: { ok: true }, awaitingApproval: false, streamActive: false }), "finished");
  assert.equal(resolveToolLifecycle({ state: "approval-requested", awaitingApproval: true, streamActive: false }), "awaiting");
  assert.equal(resolveToolLifecycle({ state: "call", awaitingApproval: false, streamActive: false }), "interrupted");
  assert.equal(resolveToolLifecycle({ state: "call", awaitingApproval: false, streamActive: true }), "running");
});
