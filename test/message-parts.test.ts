import assert from "node:assert/strict";
import test from "node:test";
import { errorText, modelRetryText, recoveryPrompt } from "../src/web/studio/MessageParts";
import { quickChoiceConfig } from "../src/web/studio/quick-choice-config";
import { quickChoices } from "../src/web/studio/quick-choices";

test("chat errors hide upstream request details", () => {
  const raw = `APICallError ${JSON.stringify({ requestBodyValues: { tools: ["secret schema"] }, responseHeaders: { trace: "internal" } })}`;
  assert.equal(errorText(raw), "模型服务调用失败，自动重试仍未恢复；你可以重试本次操作，若持续失败请检查模型设置。");
  assert.equal(errorText({ error: { message: "参数暂时不可用。" } }), "参数暂时不可用。");
});

test("model retry status is Chinese and recovery rereads current authority without replaying tools", () => {
  assert.equal(modelRetryText({ type: "data-model-retry", data: { attempt: 2, maxRetries: 3, delayMs: 4_000 } }), "模型服务暂时不可用，正在第 2/3 次自动重试…");
  assert.equal(modelRetryText({ type: "data-something-else", data: { attempt: 2, maxRetries: 3 } }), undefined);
  const prompt = recoveryPrompt("请创建蓝图并开始前三章");
  assert.match(prompt, /重新读取当前作品的最新权威状态/);
  assert.match(prompt, /不要重复已经成功的工具调用/);
  assert.match(prompt, /请创建蓝图并开始前三章/);
  assert.equal(recoveryPrompt(prompt), prompt);
});

test("three or more sequential Markdown options become quick choices", () => {
  assert.equal(quickChoiceConfig.minimumSequentialChoices, 3);
  assert.equal(quickChoiceConfig.maximumChoices, 8);
  assert.deepEqual(quickChoices("请选择：\n\n1. **升级破局**：立即翻盘\n2. [经营成长](https://example.com)：积累资源\n3、规则闯关：逐步揭秘"), [
    { number: 1, label: "升级破局" },
    { number: 2, label: "经营成长" },
    { number: 3, label: "规则闯关" },
  ]);
  assert.deepEqual(quickChoices("1. 方案一\n2. 方案二"), []);
  assert.deepEqual(quickChoices("```md\n1. 示例一\n2. 示例二\n3. 示例三\n```"), []);
  assert.deepEqual(quickChoices("**1. 【女频-古言】《替嫁毒医》** 一句话爆点：医毒双绝替嫁入府。\n\n**2. 【女频-古言】《替嫁账房》** 一句话爆点：账房女掌控王府产业。\n\n**3. 【女频-古言】《疯王与替嫁》** 一句话爆点：两个狠角色互相试探。"), [
    { number: 1, label: "【女频-古言】《替嫁毒医》" },
    { number: 2, label: "【女频-古言】《替嫁账房》" },
    { number: 3, label: "【女频-古言】《疯王与替嫁》" },
  ]);
  assert.deepEqual(quickChoices("沿这个方向给你两份蓝图。\n\n方案一《疯王与替嫁》——双强博弈版\n\n1. 主角互相利用\n2. 关系持续升级\n3. 权力格局变化\n\n方案二《替嫁医妃》——悬疑查案版\n\n从王府谜案切入。"), [
    { number: 1, label: "《疯王与替嫁》——双强博弈版" },
    { number: 2, label: "《替嫁医妃》——悬疑查案版" },
  ]);
});
