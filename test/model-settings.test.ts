import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelSettingsStore } from "../src/infrastructure/model-settings";
import { Agent } from "@mastra/core/agent";
import { CUSTOM_API_KEY, CUSTOM_PROVIDER_ID, modelSettingsInputSchema } from "../src/shared/contracts";

test("analysis model profile survives persistence and is selected independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-model-settings-"));
  try {
    const store = new ModelSettingsStore(root);
    await store.save("openai", "default-model", {});
    await store.saveProfiles({ profiles: { analysis: { providerId: "openai", modelId: "analysis-model", parameters: { maxOutputTokens: 12_000 } } } });
    const profiles = await store.profiles();
    assert.equal(profiles.profiles.analysis?.modelId, "analysis-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom provider validates URLs before saving and retains protected credentials and profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-custom-model-"));
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    const store = new ModelSettingsStore(root);
    for (const baseURL of [undefined, "not-a-url", "file:///tmp/model", "ftp://example.com", "https://user:password@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret"]) {
      assert.equal(modelSettingsInputSchema.safeParse({ providerId: CUSTOM_PROVIDER_ID, modelId: "model", baseURL }).success, false);
    }
    await assert.rejects(store.save(CUSTOM_PROVIDER_ID, "model", {}, "https://example.com/v1"), /API Key/);
    const status = await store.save(CUSTOM_PROVIDER_ID, " vendor/custom-model ", { [CUSTOM_API_KEY]: "test-custom-secret" }, " https://example.com/v1/ ");
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes("test-custom-secret"), false);
    assert.equal((await readFile(path.join(root, "settings/model.json"), "utf8")).includes("test-custom-secret"), false);
    if (store.canPersistSecrets) assert.equal((await readFile(path.join(root, "secrets/providers.json"), "utf8")).includes("test-custom-secret"), false);
    await store.save(CUSTOM_PROVIDER_ID, "vendor/custom-model", {}, "https://example.com/v1");
    await store.saveProfiles({ profiles: { critic: { providerId: CUSTOM_PROVIDER_ID, modelId: "review-model", parameters: { maxOutputTokens: 512 } } } });
    await store.save("openai", "official-model", { OPENAI_API_KEY: "test-official-secret" });
    const reloaded = new ModelSettingsStore(root);
    assert.deepEqual((await reloaded.profiles()).customProvider, { baseURL: "https://example.com/v1", modelId: "vendor/custom-model" });
    const selected = await reloaded.runtimeSelection("analysis");
    assert.deepEqual(selected.modelConfig, { providerId: CUSTOM_PROVIDER_ID, modelId: "review-model", url: "https://example.com/v1", apiKey: "test-custom-secret" });
    assert.equal(selected.parameters.maxOutputTokens, 512);
    assert.equal((await reloaded.runtimeSelection()).modelConfig, "openai/official-model");
    await assert.rejects(reloaded.save(CUSTOM_PROVIDER_ID, "model", {}, "https://other.example.com/v1"), /API Key/);
    assert.equal((await reloaded.selection())?.providerId, "openai");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("custom model discovery uses supplied or same-endpoint saved keys without changing settings", async () => {
  let mode = "success";
  const received: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    if (mode === "redirect") { response.writeHead(302, { Location: "/redirect-target" }); response.end(); return; }
    if (mode === "401" || mode === "404") { response.writeHead(Number(mode)); response.end("upstream-private-key"); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(mode === "invalid-json" ? "upstream-private-key" : JSON.stringify(mode === "invalid" ? { error: "upstream-private-key" } : { data: mode === "empty" ? [] : [{ id: "vendor/z" }, { id: "vendor/a" }, { id: "vendor/z" }, { id: "" }, { id: 12 }] }));
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-model-discovery-"));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const store = new ModelSettingsStore(root);
    await assert.rejects(store.fetchCustomModels({ baseURL }), /API Key/);
    assert.equal(received.length, 0);
    const result = await store.fetchCustomModels({ baseURL: `${baseURL}/`, apiKey: " draft-key " });
    assert.deepEqual(result.models, [{ id: "vendor/a", name: "vendor/a" }, { id: "vendor/z", name: "vendor/z" }]);
    assert.deepEqual(received.at(-1), { url: "/v1/models", authorization: "Bearer draft-key" });
    assert.equal(await store.selection(), undefined);
    await store.save(CUSTOM_PROVIDER_ID, "vendor/a", { [CUSTOM_API_KEY]: "saved-key" }, baseURL);
    await store.fetchCustomModels({ baseURL, apiKey: "unsaved-key" });
    await store.fetchCustomModels({ baseURL });
    assert.equal(received.at(-1)?.authorization, "Bearer saved-key");
    const count = received.length;
    await assert.rejects(store.fetchCustomModels({ baseURL: `${baseURL}/other` }), /API Key/);
    assert.equal(received.length, count);
    for (const [nextMode, message] of [["401", "密钥无效"], ["404", "未找到模型接口"], ["empty", "没有返回可用模型"], ["invalid", "格式不兼容"], ["invalid-json", "无法获取模型列表"], ["redirect", "无法获取模型列表"]] as const) {
      mode = nextMode;
      await assert.rejects(store.fetchCustomModels({ baseURL }), (error: Error) => error.message.includes(message) && !error.message.includes("upstream-private-key"));
    }
    assert.equal(received.some((item) => item.url === "/redirect-target"), false);
    assert.equal((await store.selection())?.modelId, "vendor/a");
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Mastra sends custom model requests to the saved endpoint", { timeout: 20_000 }, async () => {
  let received: { url?: string; authorization?: string; model?: string } | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    received = { url: request.url, authorization: request.headers.authorization, model: input.model };
    const completion = { id: "test", object: "chat.completion", created: 1, model: input.model, choices: [{ index: 0, message: { role: "assistant", content: "connected" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (input.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "connected" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(completion));
    }
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-custom-call-"));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const store = new ModelSettingsStore(root);
    await store.save(CUSTOM_PROVIDER_ID, "vendor/test-model", { [CUSTOM_API_KEY]: "local-test-key" }, `http://127.0.0.1:${address.port}/v1`);
    const agent = new Agent({ id: "custom-provider-test", name: "Custom provider test", instructions: "Return connected.", model: (await store.runtimeSelection()).modelConfig, maxRetries: 0 });
    const result = await agent.generate("test");
    assert.equal(result.text, "connected");
    assert.deepEqual(received, { url: "/v1/chat/completions", authorization: "Bearer local-test-key", model: "vendor/test-model" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
