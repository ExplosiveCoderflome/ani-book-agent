import { expect, test, type Page } from "@playwright/test";

const novelId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const now = "2026-08-17T00:00:00.000Z";

const bootstrap = { models: { configured: true, configuredProviders: ["openai"] }, novels: [], service: { studio: "ready", workbench: "ready" } };
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

async function routeJson(page: Page, handler: (url: URL, method: string) => { status?: number; body: unknown }) {
  await page.route("**/api/**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/workbench-api/**", async (route) => {
    const result = handler(new URL(route.request().url()), route.request().method());
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

test("reference library confirms chapters and token budget before starting", async ({ page }) => {
  let confirmed = false;
  const referenceId = "33333333-3333-4333-8333-333333333333"; const manifestHash = "d".repeat(64);
  const state = { version: 1, referenceId, title: "长篇测试", source: { fileName: "长篇.txt", encoding: "utf-8", sizeBytes: 1000, chars: 900, sha256: "e".repeat(64), importedAt: now, rightsConfirmed: true }, manifestHash, manifestConfirmed: false, analyses: [], updatedAt: now };
  const manifest = { version: 1, sourceHash: state.source.sha256, method: "headings", targetChars: 8000, totalChars: 900, generatedAt: now, sha256: manifestHash, chapters: Array.from({ length: 3 }, (_, index) => ({ id: `chapter-${String(index + 1).padStart(4, "0")}`, index, title: `第${index + 1}章`, start: index * 300, end: (index + 1) * 300, kind: "chapter" })) };
  const estimate = { calls: 5, inputMin: 100000, inputMax: 150000, outputMin: 10000, outputMax: 20000, recommendedBudget: 31950 };
  const job = { id: "reference-job", referenceId, analysisId: "analysis", mode: "standard", focuses: [], status: "running", stage: "准备批次", completed: 0, total: 5, tokenBudget: 100000, inputTokens: 0, outputTokens: 0, usageEstimated: false, createdAt: now, updatedAt: now };
  await routeJson(page, (url, method) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith(`/references/${referenceId}`) && method === "GET") return { body: { state: { ...state, manifestConfirmed: confirmed }, manifest, estimate } };
    if (url.pathname.endsWith("/manifest") && method === "PUT") { confirmed = true; return { body: { state: { ...state, manifestConfirmed: true }, manifest } }; }
    if (url.pathname.endsWith("/estimate") && method === "POST") return { body: estimate };
    if (url.pathname.endsWith("/jobs") && method === "POST") return { body: job };
    if (url.pathname.endsWith("/jobs/reference-job")) return { body: job };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/references/${referenceId}`);
  await expect(page.getByText("第1章").first()).toBeVisible();
  await page.getByRole("button", { name: "确认切分" }).click();
  await expect(page.getByText("章节切分已确认")).toBeVisible();
  await expect(page.getByText(/100,000–150,000/)).toBeVisible();
  await expect(page.locator(".budget-input input")).toHaveValue("100000");
  await page.getByRole("button", { name: "确认预算并开始" }).click();
  await expect(page.getByRole("heading", { name: "准备批次" })).toBeVisible();
});

test("failed reference job returns to a recoverable setup instead of a missing analysis", async ({ page }) => {
  const referenceId = "33333333-3333-4333-8333-333333333334"; const manifestHash = "f".repeat(64);
  const failed = { id: "failed-job", referenceId, analysisId: "failed-analysis", mode: "standard", focuses: [], status: "failed", stage: "聚合全书结构", completed: 3, total: 6, tokenBudget: 100000, inputTokens: 1000, outputTokens: 200, usageEstimated: false, error: "没有找到这份拆书结果。", createdAt: now, updatedAt: now };
  const state = { version: 1, referenceId, title: "失败恢复测试", source: { fileName: "测试.txt", encoding: "utf-8", sizeBytes: 1000, chars: 900, sha256: "e".repeat(64), importedAt: now, rightsConfirmed: true }, manifestHash, manifestConfirmed: true, analyses: [{ id: failed.analysisId, mode: "standard", focuses: [], status: "failed", sourceHash: "e".repeat(64), manifestHash, promptVersion: "1", tokenBudget: 100000, inputTokens: 1000, outputTokens: 200, usageEstimated: false, stale: false, staleReasons: [], createdAt: now, updatedAt: now }], updatedAt: now };
  const manifest = { version: 1, sourceHash: state.source.sha256, method: "fixed", targetChars: 8000, totalChars: 900, generatedAt: now, sha256: manifestHash, confirmedAt: now, chapters: [{ id: "chapter-0001", index: 0, title: "片段 1", start: 0, end: 900, kind: "chapter" }] };
  const estimate = { calls: 5, inputMin: 10000, inputMax: 20000, outputMin: 1000, outputMax: 2000, recommendedBudget: 100000 };
  await routeJson(page, (url) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith(`/references/${referenceId}`)) return { body: { state, manifest, estimate, activeJob: failed } };
    if (url.pathname.endsWith("/estimate")) return { body: estimate };
    if (url.pathname.endsWith("/jobs/failed-job")) return { body: failed };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/references/${referenceId}`);
  await expect(page.getByRole("heading", { name: "选择拆书深度" })).toBeVisible();
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
  const discoveryMessage = { id: "discovery-1", role: "assistant", content: { parts: [{ type: "text", text: "先说说你最想保留的阅读感觉。\n\n**三十年的运作方式**\n\n这是一段用于确认长消息段落间距的正文。\n\n1. **验货追杀**：持续制造压力\n2. **江湖挑战**：推进公开冲突\n\n---\n\n你可以直接回复编号、名称，或者告诉我想怎么改。" }] } };
  const idea = { path: "workspace/ideas.md", sha256: sha, version: 1, source: "author", protected: true, updatedAt: now, size: 18, content: "# 灵感记录\n\n一座永远下雨的城市。" };
  const snapshot = { novel: { schemaVersion: 2, novelId, title: "未命名雨城", phase: "discovery", currentVolume: 1, nextChapter: 1, approvalMode: "milestone", files: { [idea.path]: idea }, appliedProposalIds: [], updatedAt: now }, files: [idea], availability: { allowedOperations: ["propose_blueprint"], blockers: [] } };
  await routeJson(page, (url) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [discoveryMessage] } };
    if (url.pathname.endsWith("/files/content")) return { body: idea };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/novels/${novelId}`);
  await expect(page.getByRole("button", { name: /灵感便笺/ })).toBeVisible();
  await expect(page.locator(".novel-markdown-content")).toContainText("一座永远下雨的城市");
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
  const bindings = { path: "workspace/skill-bindings.yaml", sha256: "c".repeat(64), version: 1, source: "agent", protected: false, updatedAt: now, size: 22, content: "version: 1\nskills: []\n" };
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
  await expect(page.locator(".novel-markdown-content")).toContainText("一座雨城");
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.getByRole("button", { name: /skill-bindings.yaml/ }).click();
  await expect(page.getByLabel("skill-bindings.yaml")).toHaveValue(bindings.content);
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.getByRole("button", { name: /灵感便笺/ }).click();
  await expect(page.locator(".novel-markdown-content")).toContainText("一座雨城");
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(dialogCount).toBe(0);
  await page.getByRole("button", { name: /skill-bindings.yaml/ }).click();
  await page.getByLabel("skill-bindings.yaml").fill(`${bindings.content}enabled: true\n`);
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("writing workspace restores protected draft, suspended job and line diff", async ({ page }) => {
  const message = { id: "message-1", role: "assistant", content: { parts: [{ type: "tool-propose_patch", toolName: "propose_patch", toolCallId: "call-1", state: "output-available", input: {}, output: { ok: true, proposal } }] } };
  const file = { path: "chapters/chapter-002.md", sha256: sha, version: 2, source: "author", protected: true, updatedAt: now, size: 31, content: "# 第二章\n主角转身离开。" };
  const job = { id: "job-1", novelId, goal: "write_chapters", scope: { fromChapter: 2, toChapter: 4 }, status: "awaiting_author", cursor: 2, baseStateHash: "b".repeat(64), createdAt: now, updatedAt: now };
  const snapshot = { novel: { schemaVersion: 2, novelId, title: "雾港来信", phase: "writing", currentVolume: 1, nextChapter: 2, activeJobId: job.id, approvalMode: "milestone", files: { [file.path]: file }, appliedProposalIds: [], updatedAt: now }, files: [file], characterStates: [{ id: "hero", name: "林默", role: "主角", goal: "找到失踪的师父", state: "负伤停留在雾港", knowledge: ["旧码头下面有密道"], relationships: ["阿宁：互相试探"] }], activeJob: job, availability: { allowedOperations: [], blockers: [{ code: "ACTIVE_JOB", message: "当前作品已有生产任务。" }], activeJob: job } };
  await routeJson(page, (url) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/snapshot")) return { body: snapshot };
    if (url.pathname.endsWith("/chat")) return { body: { messages: [message] } };
    if (url.pathname.endsWith("/files/content")) return { body: file };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto(`/novels/${novelId}`);
  await expect(page.getByText("第 2 章需要你的判断", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-panel").getByText("章节生产已暂停")).toBeVisible();
  await expect(page.getByText("作者保护").first()).toBeVisible();
  await expect(page.locator(".character-states").getByText("林默")).toBeVisible();
  await page.locator(".character-states summary").click();
  await expect(page.locator(".character-states").getByText("找到失踪的师父")).toBeVisible();
  await expect(page.locator(".character-states").getByText("旧码头下面有密道")).toBeVisible();
  await expect(page.getByRole("heading", { name: "收紧第二章转折" })).toBeVisible();
  await expect(page.locator(".line-diff .remove")).toContainText("主角转身离开。");
  await expect(page.locator(".line-diff .add").filter({ hasText: "主角决定留下。" })).toBeVisible();
  await expect(page.locator(".writing-main")).toHaveCSS("grid-template-columns", "390px");
});
