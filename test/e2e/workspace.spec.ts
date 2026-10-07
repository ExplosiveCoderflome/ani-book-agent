import { expect, test, type Page } from "@playwright/test";
import { stringify } from "yaml";

const novelId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const now = "2026-08-17T00:00:00.000Z";
const defaultReferenceParser = { version: 1 as const, patterns: [{ id: "numbered-chapter", name: "数字与中文章回", pattern: "^(?:第\\s*)?\\d+\\s*章", enabled: true, source: "builtin" as const }] };

const bootstrap = { models: { configured: true, configuredProviders: ["openai"] }, novels: [], service: { studio: "ready", workbench: "ready" } };

test("custom provider settings validate, save and restore endpoint and model", async ({ page }, testInfo) => {
  let saved: any;
  const modelRequests: any[] = [];
  let modelProfiles: any = { default: { providerId: "openai", modelId: "official-model", parameters: {} }, profiles: {} };
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/providers")) return { body: { providers: [
      { id: "openai", name: "OpenAI", label: "OpenAI", envVar: ["OPENAI_API_KEY"], connected: true, models: [{ id: "official-model", name: "Official model" }] },
      { id: "custom", name: "Custom", label: "第三方（OpenAI 兼容）", envVar: ["CUSTOM_API_KEY"], connected: Boolean(saved), models: [] },
    ] } };
    if (url.pathname.endsWith("/model-settings") && method === "PUT") {
      saved = body; modelProfiles = { ...modelProfiles, default: { providerId: body.providerId, modelId: body.modelId, parameters: {} }, customProvider: { baseURL: body.baseURL, modelId: body.modelId } };
      return { body: { configured: true } };
    }
    if (url.pathname.endsWith("/model-settings/models")) {
      modelRequests.push(body);
      if (modelRequests.length === 1) return { status: 502, body: { error: { message: "密钥无效或无权获取模型，请检查 API Key。" } } };
      return { body: { models: [{ id: "vendor/creative-model", name: "vendor/creative-model" }, { id: "vendor/analysis-model", name: "vendor/analysis-model" }] } };
    }
    if (url.pathname.endsWith("/model-profiles")) {
      if (method === "PUT") modelProfiles.profiles = body.profiles;
      return { body: modelProfiles };
    }
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto("/projects");
  await page.getByRole("button", { name: "模型设置" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/^默认模型/)).toHaveValue("official-model");
  await dialog.getByRole("button", { name: "第三方提供商", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "第三方提供商", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel(/^默认模型/)).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "获取模型", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await dialog.getByLabel("API 地址（Base URL）").fill("not-a-url");
  await dialog.getByLabel("API Key", { exact: true }).fill("test-browser-key");
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(dialog.getByText("请输入有效的 API 地址", { exact: true })).toBeVisible();
  expect(saved).toBeUndefined();
  expect(modelRequests).toHaveLength(0);
  await dialog.getByLabel("API 地址（Base URL）").fill("https://api.example.com/v1/");
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(dialog.getByText("密钥无效或无权获取模型，请检查 API Key。", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(/^默认模型/)).toBeDisabled();
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(dialog.getByText("已获取 2 个模型", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await dialog.getByLabel(/^默认模型/).selectOption("vendor/creative-model");
  await dialog.getByLabel("API Key", { exact: true }).fill("updated-key");
  await expect(dialog.getByLabel(/^默认模型/)).toBeDisabled();
  await dialog.getByLabel("API Key", { exact: true }).fill("test-browser-key");
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  let pendingModelRequest: import("@playwright/test").Route | undefined;
  await page.route("**/workbench-api/model-settings/models", (route) => { pendingModelRequest = route; }, { times: 1 });
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在获取…", exact: true })).toBeDisabled();
  await expect.poll(() => Boolean(pendingModelRequest)).toBe(true);
  await dialog.getByLabel("API 地址（Base URL）").fill("https://other.example.com/v1");
  const oldResponse = page.waitForResponse((response) => response.url().endsWith("/model-settings/models"));
  await pendingModelRequest!.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [{ id: "stale-model", name: "stale-model" }] }) });
  await oldResponse;
  await expect(dialog.getByLabel(/^默认模型/)).toBeDisabled();
  await expect(dialog.getByRole("option", { name: "stale-model", exact: true })).toHaveCount(0);
  await dialog.getByLabel("API 地址（Base URL）").fill("https://api.example.com/v1/");
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(dialog.getByLabel(/^默认模型/)).toBeEnabled();
  expect(modelRequests.at(-1)).toEqual({ baseURL: "https://api.example.com/v1", apiKey: "test-browser-key" });
  await dialog.getByLabel("拆书分析模型").selectOption(JSON.stringify(["custom", "vendor/creative-model"]));
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saved).toEqual({ providerId: "custom", modelId: "vendor/creative-model", baseURL: "https://api.example.com/v1", credentials: { CUSTOM_API_KEY: "test-browser-key" } });
  await page.reload();
  await page.getByRole("button", { name: "模型设置" }).click();
  await expect(dialog.getByLabel("默认提供商")).toHaveValue("custom");
  await expect(dialog.getByLabel("API 地址（Base URL）")).toHaveValue("https://api.example.com/v1");
  await expect(dialog.getByLabel(/^默认模型/)).toHaveValue("vendor/creative-model");
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel(/^默认模型/)).toBeDisabled();
  await dialog.getByRole("button", { name: "获取模型", exact: true }).click();
  await expect(dialog.getByLabel(/^默认模型/)).toBeEnabled();
  expect(modelRequests.at(-1)).toEqual({ baseURL: "https://api.example.com/v1", apiKey: "" });
  await expect(dialog.getByLabel("拆书分析模型")).toHaveValue(JSON.stringify(["custom", "vendor/creative-model"]));
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("custom-provider-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("custom-provider-desktop.png") });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saved.credentials).toEqual({});
});
const proposal = {
  id: "22222222-2222-4222-8222-222222222222",
  novelId,
  intent: "让第二章的选择更明确",
  summary: "收紧第二章转折",
  changes: [{ operation: "replace", path: "chapters/chapter-002.md", baseSha256: sha, content: "# 第二章\n主角决定留下。\n新的危险逼近。" }],
  approval: "author",
  status: "pending",
  createdAt: now,
};

async function routeJson(page: Page, handler: (url: URL, method: string, requestBody?: any) => { status?: number; body: unknown }) {
  await page.route("**/api/**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/workbench-api/**", async (route) => {
    let requestBody: unknown;
    try { requestBody = route.request().postDataJSON(); } catch { requestBody = undefined; }
    const result = handler(new URL(route.request().url()), route.request().method(), requestBody);
    await route.fulfill({ status: result.status ?? 200, contentType: "application/json", body: JSON.stringify(result.body) });
  });
}

test("narrow empty project page shows readable API errors instead of object strings", async ({ page }) => {
  await routeJson(page, (url, method) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/novels") && method === "POST") return { status: 500, body: { error: { code: "CREATE_FAILED", message: "新建作品失败，请重试。", recoverable: true } } };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto("/");
  await page.getByPlaceholder("给新作品一个临时名字").fill("窄屏测试");
  await page.getByRole("button", { name: "新建作品" }).click();
  await expect(page.getByText("新建作品失败，请重试。")).toBeVisible();
  await expect(page.getByText("[object Object]")).toHaveCount(0);
  await expect(page.locator(".home-head .theme-button")).toBeVisible();
  const referenceBox = await page.getByRole("link", { name: "拆书库" }).boundingBox();
  const skillBox = await page.getByRole("link", { name: "创作 Skill" }).boundingBox();
  expect(referenceBox && skillBox && referenceBox.x + referenceBox.width <= skillBox.x).toBeTruthy();
  await expect(page.locator(".new-novel")).toHaveCSS("flex-direction", "column");
});

test("root opens the most recent novel workspace", async ({ page }) => {
  await routeJson(page, (url) => url.pathname.endsWith("/bootstrap") ? { body: { ...bootstrap, novels: [{ novelId, title: "最近作品", phase: "writing", nextChapter: 6, updatedAt: now }] } } : { status: 404, body: { error: { message: "未模拟接口" } } });
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/novels/${novelId}$`));
});

test("market radar keeps public ranking evidence in a separate view", async ({ page }) => {
  let createdTitle: string | undefined;
  let createdApprovalMode: string | undefined;
  let recordedPreference: any;
  let agentRequests = "";
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") agentRequests += request.postData() ?? ""; });
  const snapshot = { schemaVersion: 1, capturedAt: now, sources: [
    { id: "qidian-new", platform: "qidian", label: "起点 · 新书榜", sourceUrl: "https://m.qidian.com/rank/", status: "succeeded", itemCount: 1 },
    { id: "qidian-hot", platform: "qidian", label: "起点 · 畅销榜", sourceUrl: "https://m.qidian.com/rank/hotsales/", status: "failed", itemCount: 0, error: "榜单暂不可读" },
  ], items: [{ id: "rank-1", sourceId: "qidian-new", rank: 1, title: "雾港来信", author: "南舟", category: "都市异能", sourceUrl: "https://m.qidian.com/book/123" }] };
  const createdSnapshot = { novel: { schemaVersion: 2, novelId, title: "未命名 · 都市异能", phase: "discovery", currentVolume: 1, nextChapter: 1, approvalMode: "milestone", files: {}, appliedProposalIds: [], updatedAt: now }, files: [], characterStates: [], availability: { allowedOperations: ["propose_blueprint"], blockers: [] } };
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/novels") && method === "POST") { createdTitle = body?.title; createdApprovalMode = body?.approvalMode; return { body: { novelId } }; }
    if (url.pathname.endsWith(`/novels/${novelId}/preferences`) && method === "POST") { recordedPreference = body; return { body: { ok: true } }; }
    if (url.pathname.endsWith(`/novels/${novelId}/chat`)) return { body: { messages: [] } };
    if (url.pathname.endsWith(`/novels/${novelId}/snapshot`)) return { body: { ...createdSnapshot, novel: { ...createdSnapshot.novel, approvalMode: createdApprovalMode ?? "milestone" } } };
    if (url.pathname.endsWith("/market-radar")) return { body: { snapshot, summaryCurrent: true, summary: { schemaVersion: 1, snapshotCapturedAt: now, sourceIds: ["qidian-new"], generatedAt: now, overview: "公开快照显示都市异能和经营成长信号并行出现，但这不是成功保证。", genres: [{ name: "都市异能", observation: "公开分类出现都市异能。", evidence: ["都市异能"] }, { name: "经营成长", observation: "公开标题出现经营信号。", evidence: ["经营"] }], feelCards: [{ id: "growth", label: "成长破局", prompt: "我想写主角持续成长并解决更大难题的长篇故事。", reason: "来自公开快照的成长信号。" }, { id: "business", label: "经营积累", prompt: "我想写从小资源起步的经营成长故事。", reason: "来自公开快照的经营信号。" }, { id: "mystery", label: "谜团推进", prompt: "我想写谜团层层揭开的长篇故事。", reason: "来自公开快照的悬念信号。" }, { id: "relation", label: "关系博弈", prompt: "我想写关系互动与目标冲突交织的长篇故事。", reason: "来自公开快照的关系信号。" }] } } };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto("/market-radar");
  await expect(page.getByRole("heading", { name: "市场趋势" })).toBeVisible();
  await expect(page.getByText("原始榜单证据")).toBeVisible();
  await expect(page.getByText("本榜排名")).toBeVisible();
  await expect(page.locator(".market-source-tabs button")).toHaveCount(1);
  await expect(page.locator(".market-ranking-group")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "题材观察与开书方向" })).toBeVisible();
  await expect(page.getByText("成长破局")).toBeVisible();
  await expect(page.getByText("雾港来信")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看雾港来信公开来源" })).toHaveAttribute("href", "https://m.qidian.com/book/123");
  await expect(page.getByRole("button", { name: "快速开书：都市异能" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全自动开书：都市异能" })).toBeVisible();
  await expect(page.getByRole("button", { name: "快速开书：成长破局" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全自动开书：成长破局" })).toBeVisible();
  await page.getByRole("button", { name: "快速开书：都市异能" }).click();
  await expect(page).toHaveURL(new RegExp(`/novels/${novelId}$`));
  expect(createdTitle).toBe("未命名 · 都市异能");
  expect(createdApprovalMode).toBe("milestone");
  expect(recordedPreference).toMatchObject({ kind: "choice", value: "都市异能", scope: "novel" });
  await expect.poll(() => agentRequests).toContain("都市异能");
  await page.goto("/market-radar");
  await page.getByRole("button", { name: "全自动开书：成长破局" }).click();
  await expect(page).toHaveURL(new RegExp(`/novels/${novelId}$`));
  expect(createdApprovalMode).toBe("autonomous_opening");
  await expect(page.getByText("全自动开书", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "生成两份蓝图" })).toHaveCount(0);
  await expect.poll(() => agentRequests).toContain("全自动开书授权");
});

test("market radar switches cached timestamps and analyzes the selected history", async ({ page }) => {
  const older = "2026-08-20T00:00:00.000Z";
  let summaryInput: any;
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/market-radar/summarize") && method === "POST") { summaryInput = body; return { body: { id: "history-summary", status: "running" } }; }
    if (url.pathname.endsWith("/runs/history-summary")) return { body: { id: "history-summary", status: "running" } };
    if (url.pathname.endsWith("/market-radar")) {
      const capturedAt = url.searchParams.get("capturedAt") ?? now;
      return { body: { snapshot: { schemaVersion: 1, capturedAt, sources: [{ id: "qidian-new", platform: "qidian", label: "起点 · 新书榜", sourceUrl: "https://m.qidian.com/rank/", status: "succeeded", itemCount: 1 }], items: [{ id: "book", sourceId: "qidian-new", rank: 1, title: capturedAt === older ? "历史榜单作品" : "最新榜单作品", sourceUrl: "https://m.qidian.com/book/123" }] }, history: [{ capturedAt: now, itemCount: 1 }, { capturedAt: older, itemCount: 1 }], summaryCurrent: false } };
    }
    return { status: 404, body: {} };
  });
  await page.goto("/market-radar");
  await expect(page.getByText("最新榜单作品")).toBeVisible();
  await page.getByRole("combobox", { name: "选择市场趋势采集时间" }).selectOption(older);
  await expect(page.getByText("历史榜单作品")).toBeVisible();
  await expect(page.getByText("最新榜单作品")).toHaveCount(0);
  await page.reload();
  await page.getByRole("combobox", { name: "选择市场趋势采集时间" }).selectOption(older);
  await expect(page.getByText("历史榜单作品")).toBeVisible();
  await page.getByRole("button", { name: "生成开书方向" }).click();
  await expect.poll(() => summaryInput).toEqual({ sourceIds: ["all"], capturedAt: older });
});

test("autonomous opening intent survives a failed send and exposes explicit recovery after reload", async ({ page }) => {
  const seed = { id: "feel:growth", label: "成长破局", mode: "autonomous_opening", prompt: "这是一次全自动开书授权。请完成原创开书资产和前三章。" };
  const storageKey = `ani-novel-market-quick-start:${novelId}`;
  await page.addInitScript(({ key, value }) => { if (window.sessionStorage.getItem(key)) return; window.localStorage.setItem(key, JSON.stringify(value)); window.sessionStorage.setItem(key, "seeded"); }, { key: storageKey, value: seed });
  const blueprint = { path: "book/blueprint.md", sha256: sha, version: 1, source: "agent", protected: false, updatedAt: now, size: 5 };
  let openingAssetCreated = false;
  let canceled = false;
  const snapshot = () => ({ novel: { schemaVersion: 2, novelId, title: "恢复测试", phase: "discovery", currentVolume: 1, nextChapter: 1, approvalMode: canceled ? "milestone" : "autonomous_opening", files: openingAssetCreated ? { [blueprint.path]: blueprint } : {}, appliedProposalIds: [], updatedAt: now }, files: openingAssetCreated ? [blueprint] : [], characterStates: [], availability: { allowedOperations: ["propose_blueprint"], blockers: [] } });
  let agentAttempts = 0;
  let lastAgentBody = "";
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith(`/novels/${novelId}/snapshot`)) return { body: snapshot() };
    if (url.pathname.endsWith(`/novels/${novelId}/chat`)) return { body: { messages: [] } };
    if (url.pathname.endsWith(`/novels/${novelId}/auto-opening/actions`) && method === "POST") { canceled = body.action === "cancel"; return { body: { novel: { ...snapshot().novel, approvalMode: "milestone" } } }; }
    if (url.pathname.endsWith("/market-radar")) return { body: {} };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.route("**/api/**", async (route) => {
    const body = route.request().postData() ?? "";
    const commandRequest = body.includes("全自动开书授权") || body.includes("read_project");
    if (commandRequest) { agentAttempts += 1; lastAgentBody = body; }
    if (commandRequest && agentAttempts === 1) await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "测试发送失败。" } }) });
    else await route.fulfill({ status: 204 });
  });

  await page.goto(`/novels/${novelId}`);
  await expect.poll(() => agentAttempts).toBe(1);
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), storageKey)).not.toBeNull();
  await expect(page.getByRole("button", { name: "继续全自动开书" })).toBeVisible();

  await page.reload();
  await expect.poll(() => agentAttempts).toBe(1);
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), storageKey)).not.toBeNull();
  await expect(page.getByRole("button", { name: "继续全自动开书" })).toBeVisible();
  await page.getByRole("button", { name: "继续全自动开书" }).click();
  await expect.poll(() => agentAttempts).toBe(2);
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: seed });
  openingAssetCreated = true;
  await page.reload();
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), storageKey)).toBeNull();
  await expect(page.getByRole("button", { name: "继续全自动开书" })).toBeVisible();
  await page.getByRole("button", { name: "继续全自动开书" }).click();
  await expect.poll(() => agentAttempts).toBeGreaterThanOrEqual(3);
  expect(lastAgentBody).toContain("read_project");
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: seed });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => canceled).toBe(true);
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), storageKey)).toBeNull();
  const attemptsAfterCancel = agentAttempts;
  await page.reload();
  await expect.poll(() => agentAttempts).toBe(attemptsAfterCancel);
  await expect(page.getByRole("button", { name: "继续全自动开书" })).toHaveCount(0);
});

test("private reference import starts without a rights confirmation checkbox", async ({ page }) => {
  const referenceId = "33333333-3333-4333-8333-333333333332";
  const sourceHash = "c".repeat(64);
  const manifestHash = "d".repeat(64);
  const state = { version: 1, referenceId, title: "本地参考书", source: { fileName: "参考书.txt", encoding: "utf-8", sizeBytes: 12, chars: 4, sha256: sourceHash, importedAt: now }, manifestHash, manifestConfirmed: false, analyses: [], updatedAt: now };
  const manifest = { version: 1, sourceHash, method: "fixed", targetChars: 8000, totalChars: 4, generatedAt: now, sha256: manifestHash, chapters: [{ id: "chapter-0001", index: 0, title: "片段 1", start: 0, end: 4, kind: "chapter" }] };
  await routeJson(page, (url, method) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/references") && method === "GET") return { body: { references: [] } };
    if (url.pathname.endsWith("/references/import") && method === "POST") return { status: 201, body: { state, manifest, duplicate: false } };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto("/references");
  await expect(page.getByText("我确认有权分析")).toHaveCount(0);
  await page.locator('.reference-file input[type="file"]').setInputFiles({ name: "参考书.txt", mimeType: "text/plain", buffer: Buffer.from("正文") });
  await expect(page.getByRole("button", { name: "导入并解析" })).toBeEnabled();
  await page.getByRole("button", { name: "导入并解析" }).click();
  await expect(page).toHaveURL(new RegExp(`/references/${referenceId}$`));
});

test("reference library confirms chapters and token budget before starting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let confirmed = false;
  let rebuilt = false;
  let savedParser: any;
  let parser: any = defaultReferenceParser;
  let startedRange: any; let startedPreset: any;
  const referenceId = "33333333-3333-4333-8333-333333333333"; const manifestHash = "d".repeat(64);
  const state = { version: 1, referenceId, title: "长篇测试", source: { fileName: "长篇.txt", encoding: "utf-8", sizeBytes: 1000, chars: 900, sha256: "e".repeat(64), importedAt: now }, manifestHash, manifestConfirmed: false, analyses: [], updatedAt: now };
  const manifest = { version: 1, sourceHash: state.source.sha256, method: "headings", targetChars: 8000, totalChars: 900, generatedAt: now, sha256: manifestHash, chapters: Array.from({ length: 3 }, (_, index) => ({ id: `chapter-${String(index + 1).padStart(4, "0")}`, index, title: `第${index + 1}章`, start: index * 300, end: (index + 1) * 300, kind: "chapter" })) };
  const estimate = { calls: 5, inputMin: 100000, inputMax: 150000, outputMin: 10000, outputMax: 20000, recommendedBudget: 31950 };
  const job = { id: "reference-job", referenceId, analysisId: "analysis", mode: "standard", focuses: [], chapterRange: { fromChapter: 2, toChapter: 3 }, status: "running", stage: "准备批次", completed: 0, total: 4, tokenBudget: 100000, inputTokens: 0, outputTokens: 0, usageEstimated: false, createdAt: now, updatedAt: now, progress: { phaseIndex: 1, phaseTotal: 4, detail: "正在核对原文、章节范围与预算，随后开始逐批读取。", chaptersCovered: 0, chaptersTotal: 2, batchesCompleted: 0, batchesTotal: 1, segmentsCompleted: 0, segmentsTotal: 1, macrosCompleted: 0, macrosTotal: 1, focusesCompleted: 0, focusesTotal: 0, reportCompleted: false } };
  await routeJson(page, (url, method, requestBody) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith(`/references/${referenceId}`) && method === "GET") return { body: { state: { ...state, manifestConfirmed: confirmed }, manifest, parser, estimate } };
    if (url.pathname.endsWith(`/references/${referenceId}/source`)) return { body: { start: 0, end: 300, content: "第1章\n这是第一章的完整正文。" } };
    if (url.pathname.endsWith(`/references/${referenceId}/parser/suggest`) && method === "POST") return { body: { name: "三位数字章节", pattern: "^\\d{3}章", explanation: "匹配 001章、002章 等三位数字章节标题。" } };
    if (url.pathname.endsWith(`/references/${referenceId}/parser`) && method === "PUT") { parser = { version: 1, patterns: [...defaultReferenceParser.patterns, { id: "ai-test", name: "三位数字章节", pattern: "^\\d{3}章", enabled: true, source: "ai" }] }; savedParser = parser; return { body: { state, manifest, parser } }; }
    if (url.pathname.endsWith(`/references/${referenceId}/manifest/rebuild`) && method === "POST") { rebuilt = true; confirmed = false; return { body: { state, manifest, parser } }; }
    if (url.pathname.endsWith("/manifest") && method === "PUT") { confirmed = true; return { body: { state: { ...state, manifestConfirmed: true }, manifest } }; }
    if (url.pathname.endsWith("/estimate") && method === "POST") return { body: estimate };
    if (url.pathname.endsWith("/jobs") && method === "POST") { startedRange = requestBody?.chapterRange; startedPreset = requestBody?.preset; return { body: job }; }
    if (url.pathname.endsWith("/jobs/reference-job")) return { body: job };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/references/${referenceId}`);
  await expect(page.getByText("第1章").first()).toBeVisible();
  await expect(page.getByText("这是第一章的完整正文。")).toBeVisible();
  const controlPane = page.locator(".reference-control-pane");
  const sourceReader = page.locator(".reference-source-reader");
  const referenceResizer = page.getByRole("separator", { name: "调整拆书设置栏宽度" });
  const controlBefore = await controlPane.boundingBox();
  const readerBefore = await sourceReader.boundingBox();
  const resizerBox = await referenceResizer.boundingBox();
  if (!controlBefore || !readerBefore || !resizerBox) throw new Error("拆书左右分栏没有完成布局。");
  expect(readerBefore.x + readerBefore.width).toBeLessThanOrEqual(controlBefore.x);
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x - 70, resizerBox.y + 120);
  await page.mouse.up();
  await expect.poll(async () => (await controlPane.boundingBox())?.width ?? 0).toBeGreaterThan(controlBefore.width + 50);
  await page.locator(".reference-parser-editor>summary").click();
  await page.getByPlaceholder(/每行粘贴一个真实章节标题/).fill("001章\n002章 餐厅约会");
  await page.getByRole("button", { name: "生成候选正则" }).click();
  await expect(page.getByText("匹配 001章、002章 等三位数字章节标题。")).toBeVisible();
  await expect(page.getByLabel("正则 三位数字章节")).toHaveValue("^\\d{3}章");
  await page.getByRole("button", { name: "保存规则并重新识别" }).click();
  await expect.poll(() => savedParser?.patterns.length ?? 0).toBe(2);
  await page.getByRole("button", { name: "重新识别章节" }).click();
  await expect.poll(() => rebuilt).toBe(true);
  await page.getByRole("button", { name: "确认切分" }).click();
  await expect(page.getByText("章节切分已确认")).toBeVisible();
  await page.getByRole("slider", { name: "起始章节" }).press("ArrowRight");
  await expect(page.getByText("第 2–3 章")).toBeVisible();
  await expect(page.getByText("共 2 章 · 约 600 字符")).toBeVisible();
  await expect(page.getByText(/100,000–150,000/)).toBeVisible();
  await expect(page.locator(".budget-input input")).toHaveValue("100000");
  await page.getByRole("button", { name: "完整拆书" }).click();
  await page.getByRole("button", { name: "确认预算并开始" }).click();
  await expect.poll(() => startedRange).toEqual({ fromChapter: 2, toChapter: 3 });
  await expect.poll(() => startedPreset).toBe("complete");
  await expect(page.getByRole("heading", { name: "准备批次" })).toBeVisible();
  await expect(page.getByText("原文章节")).toBeVisible();
  await expect(page.getByText("逐章批次")).toBeVisible();
  await expect(page.getByText("剩余预算")).toBeVisible();
});

test("new reference radar creates an author-approved adaptation without auto-starting production", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const referenceId = "44444444-4444-4444-8444-444444444444";
  const analysisId = "analysis-radar";
  const manifestHash = "4".repeat(64);
  const sourceHash = "5".repeat(64);
  const insight = { id: "cost-escalation", title: "胜利成本递增", mechanism: "每次兑现都附带更高成本。", fitFor: ["升级线"], doNotCopy: ["原作角色与事件"], adaptationHint: "替换为目标作品既有资源。", evidence: [{ chapterId: "chapter-0001", excerpt: "主角取胜后失去资源。", start: 0, end: 10 }] };
  const analysis = { id: analysisId, mode: "standard", preset: "standard", focuses: [], sectionKeys: ["overview"], status: "completed", sourceHash, manifestHash, promptVersion: "5", tokenBudget: 100000, inputTokens: 2000, outputTokens: 1000, usageEstimated: false, stale: false, staleReasons: [], radarPath: "radar.yaml", characterProfiles: [], createdAt: now, updatedAt: now };
  const state = { version: 1, referenceId, title: "雷达参考书", source: { fileName: "雷达.txt", encoding: "utf-8", sizeBytes: 100, chars: 60, sha256: sourceHash, importedAt: now }, manifestHash, manifestConfirmed: true, latestAnalysisId: analysisId, analyses: [analysis], updatedAt: now };
  const manifest = { version: 1, sourceHash, method: "headings", targetChars: 8000, totalChars: 60, generatedAt: now, sha256: manifestHash, chapters: [{ id: "chapter-0001", index: 0, title: "第一章", start: 0, end: 60, kind: "chapter" }] };
  const section = { version: 1, key: "overview", title: "全书总览", summary: "作品用连续成本维持升级压力。", content: "## 全书总览\n\n完整分析。", structuredData: {}, evidence: insight.evidence, insights: [insight], characterCandidates: [], createdAt: now };
  const systems = [
    ["character", 12], ["geography", 10], ["narrative", 15], ["power", 10], ["worldview", 11], ["expression", 8], ["form", 4],
  ].map(([systemId, totalDimensions], index) => ({ systemId, score: index === 2 ? 82 : null, coverage: index === 2 ? 1 / Number(totalDimensions) : 0, observedDimensions: index === 2 ? 1 : 0, totalDimensions: Number(totalDimensions) }));
  const radar = { schemaVersion: 1, systems, observations: [{ dimensionId: "33", summary: "递进成本形成节奏压力。", transferableMechanism: insight.mechanism, score: 4.1, confidence: .9, evidence: insight.evidence, insightId: insight.id }], recommendedInsightIds: [insight.id], generatedAt: now };
  let createdBody: any;
  let productionStarted = false;
  let proposed: any = { schemaVersion: 1, id: "55555555-5555-4555-8555-555555555555", novelId, referenceId, analysisId, analysisSha256: "6".repeat(64), targetStateSha256: "7".repeat(64), authorityFiles: {}, selectedInsightIds: [insight.id], selectedInsights: [{ ...insight, evidence: undefined }], scope: { fromChapter: 2, toChapter: 4 }, summary: "用递增成本强化未来三章。", constraints: { planning: ["每章提高代价"], writing: ["使用本作人物"], review: ["检查表层复制"] }, status: "proposed", staleReasons: [], createdAt: now, updatedAt: now };
  delete (proposed.selectedInsights[0] as any).evidence;
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: { ...bootstrap, novels: [{ novelId, title: "目标小说", phase: "writing", nextChapter: 2, updatedAt: now }] } };
    if (url.pathname.endsWith(`/references/${referenceId}`)) return { body: { state, manifest, parser: defaultReferenceParser, estimate: { inputMin: 1, inputMax: 2, recommendedBudget: 100000 } } };
    if (url.pathname.endsWith(`/references/${referenceId}/source`)) return { body: { start: 0, end: 60, content: "第一章\n主角取胜后失去资源。" } };
    if (url.pathname.endsWith(`/references/${referenceId}/analyses/${analysisId}`) && method === "GET") return { body: { analysis, sections: [section], radar, index: { chapterCount: 1, segmentCount: 1, inputTokens: 2000, outputTokens: 1000, usageEstimated: false } } };
    if (url.pathname.endsWith(`/references/${referenceId}/analyses/${analysisId}/adaptations`) && method === "POST") { createdBody = body; return { status: 201, body: { adaptation: proposed, file: { sha256: "8".repeat(64) } } }; }
    if (url.pathname.endsWith(`/novels/${novelId}/adaptations/${proposed.id}/actions`) && method === "POST") { proposed = { ...proposed, status: "approved", approvedAt: now }; return { body: { adaptation: proposed } }; }
    if (url.pathname.endsWith(`/novels/${novelId}/jobs`) && method === "POST") { productionStarted = true; return { status: 202, body: {} }; }
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/references/${referenceId}`);
  await page.getByRole("button", { name: "拆书结果" }).click();
  await expect(page.getByRole("heading", { name: "七大体系结构雷达" })).toBeVisible();
  await expect(page.getByText("未分析不会被当成低分")).toBeVisible();
  await page.getByText("胜利成本递增", { exact: true }).click();
  await page.locator(".adaptation-composer select").selectOption(novelId);
  await page.getByRole("button", { name: "生成提案" }).click();
  await expect.poll(() => createdBody?.selectedInsightIds).toEqual([insight.id]);
  await expect(page.getByText("等待作者批准")).toBeVisible();
  await page.getByRole("button", { name: "作者批准" }).click();
  await expect(page.getByText(/不会自动生成章节/)).toBeVisible();
  expect(productionStarted).toBe(false);
});

test("failed reference job returns to a recoverable setup instead of a missing analysis", async ({ page }) => {
  const referenceId = "33333333-3333-4333-8333-333333333334"; const manifestHash = "f".repeat(64);
  const failed = { id: "failed-job", referenceId, analysisId: "failed-analysis", mode: "standard", focuses: [], status: "failed", stage: "聚合全书结构", completed: 3, total: 6, tokenBudget: 100000, inputTokens: 1000, outputTokens: 200, usageEstimated: false, error: "没有找到这份拆书结果。", createdAt: now, updatedAt: now };
  const state = { version: 1, referenceId, title: "失败恢复测试", source: { fileName: "测试.txt", encoding: "utf-8", sizeBytes: 1000, chars: 900, sha256: "e".repeat(64), importedAt: now, rightsConfirmed: true }, manifestHash, manifestConfirmed: true, analyses: [{ id: failed.analysisId, mode: "standard", focuses: [], status: "failed", sourceHash: "e".repeat(64), manifestHash, promptVersion: "1", tokenBudget: 100000, inputTokens: 1000, outputTokens: 200, usageEstimated: false, stale: false, staleReasons: [], createdAt: now, updatedAt: now }], updatedAt: now };
  const manifest = { version: 1, sourceHash: state.source.sha256, method: "fixed", targetChars: 8000, totalChars: 900, generatedAt: now, sha256: manifestHash, confirmedAt: now, chapters: [{ id: "chapter-0001", index: 0, title: "片段 1", start: 0, end: 900, kind: "chapter" }] };
  const estimate = { calls: 5, inputMin: 10000, inputMax: 20000, outputMin: 1000, outputMax: 2000, recommendedBudget: 100000 };
  await routeJson(page, (url) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith(`/references/${referenceId}`)) return { body: { state, manifest, parser: defaultReferenceParser, estimate, activeJob: failed } };
    if (url.pathname.endsWith("/estimate")) return { body: estimate };
    if (url.pathname.endsWith("/jobs/failed-job")) return { body: failed };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/references/${referenceId}`);
  await expect(page.getByRole("heading", { name: "选择拆书档位" })).toBeVisible();
  await expect(page.getByText("没有找到这份拆书结果。")).toBeVisible();
});

test("skill library reloads changed built-in files without restarting", async ({ page }) => {
  await routeJson(page, (url, method) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/skills/reload-builtins") && method === "POST") return { body: { checked: 7, updated: ["discovery"] } };
    if (url.pathname.endsWith("/skills/sandbox/capabilities")) return { body: { configured: false, isolated: false, network: "disabled", approvalRequired: true, reason: "测试环境" } };
    if (url.pathname.endsWith("/skills")) return { body: { skills: [] } };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto("/skills");
  await page.getByRole("button", { name: "刷新内置 Skill" }).click();
  await expect(page.getByText("已刷新 1 个：开书探索")).toBeVisible();
});

test("discovery keeps project files and Agent visible at the same time", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem("ani-novel-theme", "night"));
  const discoveryMessage = { id: "discovery-1", role: "assistant", content: { parts: [{ type: "text", text: "先说说你最想保留的阅读感觉。\n\n**三十年的运作方式**\n\n这是一段用于确认长消息段落间距的正文。\n\n方案一《疯王与替嫁》——双强博弈版\n\n一句话 premise：两个狠角色互相利用。\n\n方案二《替嫁医妃》——悬疑查案版\n\n一句话 premise：从王府谜案切入。\n\n---\n\n你可以直接回复编号、名称，或者告诉我想怎么改。" }] } };
  const idea = { path: "workspace/ideas.md", sha256: sha, version: 1, source: "author", protected: true, updatedAt: now, size: 18, content: "# 灵感记录\n\n一座永远下雨的城市。" };
  const snapshot = { novel: { schemaVersion: 2, novelId, title: "未命名雨城", phase: "discovery", currentVolume: 1, nextChapter: 1, approvalMode: "milestone", files: { [idea.path]: idea }, appliedProposalIds: [], updatedAt: now }, files: [idea], availability: { allowedOperations: ["propose_blueprint"], blockers: [] } };
  let preference: any;
  await routeJson(page, (url, method, requestBody) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [discoveryMessage] } };
    if (url.pathname.endsWith("/files/content")) return { body: idea };
    if (url.pathname.endsWith("/preferences") && method === "POST") { preference = requestBody; return { body: { schemaVersion: 1, version: 1, signals: [], updatedAt: now } }; }
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/novels/${novelId}`);
  await expect(page.getByRole("heading", { name: "创作进度" })).toBeVisible();
  await expect(page.getByText("已生成内容")).toBeVisible();
  await expect(page.getByText("项目设置")).toBeVisible();
  await expect(page.getByText("参考资料")).toHaveCount(0);
  await expect(page.getByText("角色状态")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /灵感便笺/ })).toBeVisible();
  await expect(page.locator(".novel-markdown-content")).toContainText("一座永远下雨的城市");
  await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await expect(page.locator(".novel-markdown-editor .mdxeditor-toolbar")).toBeHidden();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "段落样式" })).toContainText("段落");
  await expect.poll(async () => page.getByRole("radio", { name: "可视化编辑" }).evaluate((node) => getComputedStyle(node, "::after").content)).toBe('"编辑"');
  await expect(page.getByRole("radio", { name: "源码" })).toBeVisible();
  await expect.poll(async () => Number.parseFloat(await page.locator(".novel-markdown-content h1").evaluate((node) => getComputedStyle(node).fontSize))).toBeGreaterThan(24);
  await page.locator(".novel-markdown-content p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" 新的线索");
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await page.getByRole("radio", { name: "源码" }).click();
  await expect(page.locator(".cm-editor")).toHaveCSS("background-color", "rgb(29, 29, 34)");
  await expect(page.locator(".cm-activeLine")).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByText("先说说你最想保留的阅读感觉。")).toBeVisible();
  await expect.poll(async () => Number.parseFloat(await page.locator(".message-markdown p").filter({ hasText: "三十年的运作方式" }).evaluate((node) => getComputedStyle(node).fontSize))).toBeGreaterThan(14);
  await expect(page.locator(".message-markdown hr")).toBeVisible();
  await expect(page.getByText("你可以直接回复编号、名称，或者告诉我想怎么改。")).toBeVisible();
  await expect(page.getByRole("group", { name: "快捷选择" }).getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /疯王与替嫁.*双强博弈版/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /替嫁医妃.*悬疑查案版/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "喜欢这次回复", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "喜欢这次回复", exact: true }).click();
  await expect.poll(() => preference?.kind).toBe("like");
  expect(preference.messageId).toBe("discovery-1");
  await expect(page.getByText("已记住")).toBeVisible();
  await expect(page.locator(".choice-grid")).toHaveCount(0);
  await expect(page.locator(".topbar .theme-button")).toBeVisible();
  const blueprintAction = await page.getByRole("button", { name: "生成两份蓝图" }).boundingBox(); const composer = await page.locator(".composer").boundingBox();
  if (!blueprintAction || !composer) throw new Error("蓝图动作或输入框没有完成布局。");
  expect(blueprintAction.y).toBeLessThan(composer.y);
  const panel = page.locator(".agent-panel"); const resizer = page.getByRole("separator", { name: "调整 Agent 面板宽度" });
  const before = await panel.boundingBox(); const handle = await resizer.boundingBox();
  if (!before || !handle) throw new Error("面板拖拽区域没有完成布局。");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100); await page.mouse.down(); await page.mouse.move(handle.x - 120, handle.y + 100); await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(before.width + 90);
});

test("opening Markdown and YAML does not create unsaved changes", async ({ page }) => {
  const idea = { path: "workspace/ideas.md", sha256: sha, version: 1, source: "agent", protected: false, updatedAt: now, size: 18, content: "# 灵感记录\n\n一座雨城。" };
  const bindings = { path: "workspace/references/notes.yaml", sha256: "c".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now, size: 22, content: "version: 1\nnotes: []\n" };
  const files = [idea, bindings];
  const snapshot = { novel: { schemaVersion: 2, novelId, title: "雨城", phase: "discovery", currentVolume: 1, nextChapter: 1, approvalMode: "milestone", files: Object.fromEntries(files.map((item) => [item.path, item])), appliedProposalIds: [], updatedAt: now }, files, availability: { allowedOperations: ["propose_blueprint"], blockers: [] } };
  await routeJson(page, (url) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [] } };
    if (url.pathname.endsWith("/files/content")) return { body: url.searchParams.get("path") === bindings.path ? bindings : idea };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  let dialogCount = 0;
  page.on("dialog", async (dialog) => { dialogCount += 1; await dialog.dismiss(); });
  await page.goto(`/novels/${novelId}`);
  await expect(page.locator(".initial-taste-grid").getByRole("button")).toHaveCount(6);
  await expect(page.locator(".novel-markdown-content")).toContainText("一座雨城");
  await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toHaveCount(0);
  await page.getByRole("button", { name: /notes.yaml/ }).click();
  await expect(page.getByLabel("notes.yaml")).toHaveValue(bindings.content);
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.getByRole("button", { name: /灵感便笺/ }).click();
  await expect(page.locator(".novel-markdown-content")).toContainText("一座雨城");
  await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toHaveCount(0);
  expect(dialogCount).toBe(0);
  await page.getByRole("button", { name: /notes.yaml/ }).click();
  await page.getByLabel("notes.yaml").fill(`${bindings.content}enabled: true\n`);
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("writing workspace restores protected draft, suspended job and line diff", async ({ page }) => {
  const message = { id: "message-1", role: "assistant", content: { parts: [{ type: "tool-propose_patch", toolName: "propose_patch", toolCallId: "call-1", state: "output-available", input: {}, output: { ok: true, proposal } }] } };
  const file = { path: "chapters/chapter-002.md", sha256: sha, version: 2, source: "author", protected: true, updatedAt: now, size: 31, content: "# 第二章\n主角转身离开。" };
  const character = { path: "book/characters/sidekick.md", sha256: "f".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now, size: 25, content: "# 阿宁\n\n- 叙事功能：搭档。" };
  const job = { id: "job-1", novelId, goal: "write_chapters", scope: { fromChapter: 2, toChapter: 4 }, status: "awaiting_author", cursor: 2, baseStateHash: "b".repeat(64), createdAt: now, updatedAt: now };
  const snapshot = { novel: { schemaVersion: 2, novelId, title: "雾港来信", phase: "writing", currentVolume: 1, nextChapter: 2, activeJobId: job.id, approvalMode: "milestone", files: { [file.path]: file, [character.path]: character }, appliedProposalIds: [], updatedAt: now }, files: [file, character], characterStates: [{ id: "hero", name: "林默", role: "主角", goal: "找到失踪的师父", state: "负伤停留在雾港", knowledge: ["旧码头下面有密道"], relationships: ["阿宁：互相试探"] }], activeJob: job, availability: { allowedOperations: [], blockers: [{ code: "ACTIVE_JOB", message: "当前作品已有生产任务。" }], activeJob: job } };
  await routeJson(page, (url) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [message] } };
    if (url.pathname.endsWith("/files/content")) return { body: url.searchParams.get("path") === character.path ? character : file };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/novels/${novelId}`);
  await expect(page.getByText("第 2 章需要你的判断", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-panel").getByText("章节生产已暂停")).toBeVisible();
  await expect(page.getByText("作者保护").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "收紧第二章转折" })).toBeVisible();
  await expect(page.locator(".line-diff .remove")).toContainText("主角转身离开。");
  await expect(page.locator(".line-diff .add").filter({ hasText: "主角决定留下。" })).toBeVisible();
  await page.getByRole("button", { name: /角色 · sidekick/ }).click();
  await expect(page.getByRole("button", { name: /角色 · sidekick/ })).toHaveClass(/active/);
  await expect(page.locator(".editor>header strong")).toHaveText("角色 · sidekick");
  await expect(page.locator(".novel-markdown-content")).toContainText("叙事功能：搭档");
  await expect(page.getByRole("button", { name: /待审批提案 · 收紧第二章转折/ })).toBeVisible();
  await page.getByRole("button", { name: /待审批提案 · 收紧第二章转折/ }).click();
  await expect(page.getByRole("heading", { name: "收紧第二章转折" })).toBeVisible();
  await expect(page.locator(".writing-main")).toHaveCSS("grid-template-columns", "390px");
});

test("failed production job keeps retry and dismiss actions after workspace restore", async ({ page }) => {
  const actions: string[] = [];
  const failedJob = { id: "failed-production", novelId, goal: "write_chapters", scope: { fromChapter: 2, toChapter: 4 }, status: "failed", cursor: 2, interactionMode: "autonomous_opening", retryOf: "first-attempt", attempt: 2, baseStateHash: "b".repeat(64), error: { code: "MODEL_UNAVAILABLE", message: "模型服务暂时不可用。", recoverable: true }, createdAt: now, updatedAt: now };
  let activeJob: any = { ...failedJob, status: "running" };
  const snapshot = () => ({ novel: { schemaVersion: 2, novelId, title: "失败恢复", phase: "writing", currentVolume: 1, nextChapter: 2, activeJobId: activeJob.id, approvalMode: "milestone", files: {}, appliedProposalIds: [], updatedAt: now }, files: [], characterStates: [], activeJob, availability: { allowedOperations: [], blockers: [{ code: "ACTIVE_JOB", message: "当前作品有待恢复任务。" }], activeJob } });
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot() };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [] } };
    if (url.pathname.endsWith(`/jobs/${failedJob.id}/actions`) && method === "POST") { actions.push(body.action); return { body: failedJob }; }
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/novels/${novelId}`);
  await expect(page.getByText("正在处理第 2 章 / 目标至第 4 章", { exact: false }).first()).toBeVisible();
  activeJob = { ...activeJob, modelRetry: { label: "生成第 2 章", attempt: 2, maxRetries: 3, delayMs: 4_000, updatedAt: now } };
  await page.reload();
  await expect(page.getByText("生成第 2 章 · 模型服务暂时不可用，正在第 2/3 次自动重试…", { exact: true })).toBeVisible();
  activeJob = failedJob;
  await page.reload();
  await expect(page.getByText("模型服务暂时不可用。", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("最近已稳定至第 1 章，下一步从第 2 章继续", { exact: false })).toBeVisible();
  await expect(page.getByText("第 2 次尝试")).toBeVisible();
  await page.getByRole("button", { name: "一键重试" }).click();
  await expect.poll(() => actions).toEqual(["retry"]);
  await page.getByRole("button", { name: "不再重试" }).click();
  await expect.poll(() => actions).toEqual(["retry", "cancel"]);
});

test("tension curve supports local drag, keyboard adjustment and one explicit save", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 920 });
  await page.addInitScript(() => window.localStorage.setItem("ani-novel-theme", "night"));
  let curveSha = "d".repeat(64); let saves = 0;
  let curveContent = stringify({ schemaVersion: 1, kind: "book", title: "全书张力", basis: { blueprintSha256: "b".repeat(64), generatedAt: now }, calibration: { status: "aligned", reasons: [] }, points: [
    { id: "opening", progress: 0, label: "开篇钩子", tension: 32, emotion: { kind: "curiosity", intensity: 2 }, function: "hook", rationale: "建立问题", source: "ai", locked: false },
    { id: "middle", progress: 50, label: "中段翻转", tension: 62, emotion: { kind: "pressure", intensity: 4 }, function: "turn", rationale: "改变路径", source: "ai", locked: false },
    { id: "ending", progress: 100, label: "终局兑现", tension: 91, emotion: { kind: "exhilaration", intensity: 5 }, function: "climax", rationale: "完成兑现", source: "ai", locked: false },
  ] }, { lineWidth: 0 });
  const blueprint = { path: "book/blueprint.md", sha256: "b".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now, size: 8, content: "# 蓝图\n" };
  const curve = () => ({ path: "book/tension-curve.yaml", sha256: curveSha, version: saves + 1, source: saves ? "author" : "agent", protected: Boolean(saves), updatedAt: now, size: curveContent.length, content: curveContent });
  const snapshot = () => { const files = [blueprint, curve()]; return { novel: { schemaVersion: 2, novelId, title: "曲线测试", phase: "writing", currentVolume: 1, nextChapter: 1, approvalMode: "milestone", files: Object.fromEntries(files.map((item) => [item.path, item])), appliedProposalIds: [], updatedAt: now }, files, characterStates: [], availability: { allowedOperations: ["write_chapters"], blockers: [] } }; };
  await routeJson(page, (url, method, body) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot() };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [] } };
    if (url.pathname.endsWith("/files/content")) return { body: url.searchParams.get("path") === curve().path ? curve() : blueprint };
    if (url.pathname.endsWith("/files") && method === "PUT") { saves += 1; curveContent = body.content; curveSha = "e".repeat(64); return { body: curve() }; }
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/novels/${novelId}`);
  await page.getByRole("button", { name: /全书张力曲线/ }).click();
  await expect(page.locator(".curve-chart").getByText("舒缓")).toBeVisible(); await expect(page.locator(".curve-chart").getByText("高潮")).toBeVisible();
  const middle = page.getByRole("slider", { name: /中段翻转/ });
  await expect(middle).toHaveAttribute("aria-valuenow", "62");
  await middle.press("ArrowUp"); await expect(middle).toHaveAttribute("aria-valuenow", "63");
  const box = await middle.boundingBox(); if (!box) throw new Error("曲线节点没有可拖动命中区域。");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 42, { steps: 4 });
  expect(saves).toBe(0); await page.mouse.up(); expect(saves).toBe(0);
  await expect(page.getByText("作者锁定")).toBeVisible();
  await page.getByRole("button", { name: "保存曲线" }).click();
  await expect.poll(() => saves).toBe(1);
});
