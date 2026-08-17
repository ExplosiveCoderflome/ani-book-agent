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

test("narrow home shows readable API errors instead of object strings", async ({ page }) => {
  await routeJson(page, (url, method) => {
    if (url.pathname.endsWith("/bootstrap")) return { body: bootstrap };
    if (url.pathname.endsWith("/novels") && method === "POST") return { status: 500, body: { error: { code: "CREATE_FAILED", message: "新建作品失败，请重试。", recoverable: true } } };
    return { status: 404, body: { error: { message: "未模拟接口" } } };
  });
  await page.goto("/");
  await page.getByPlaceholder("给新作品一个临时名字").fill("窄屏测试");
  await page.getByRole("button", { name: "开始创作" }).click();
  await expect(page.getByText("新建作品失败，请重试。")).toBeVisible();
  await expect(page.getByText("[object Object]")).toHaveCount(0);
  await expect(page.locator(".home-head .theme-button")).toBeVisible();
  await expect(page.locator(".new-novel")).toHaveCSS("flex-direction", "column");
});

test("discovery keeps project files and Agent visible at the same time", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const discoveryMessage = { id: "discovery-1", role: "assistant", content: { parts: [{ type: "text", text: "先说说你最想保留的阅读感觉。" }] } };
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
  await expect(page.getByLabel("灵感便笺")).toHaveValue(/一座永远下雨的城市/);
  await expect(page.getByText("先说说你最想保留的阅读感觉。")).toBeVisible();
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

test("writing workspace restores protected draft, suspended job and line diff", async ({ page }) => {
  const message = { id: "message-1", role: "assistant", content: { parts: [{ type: "tool-propose_patch", toolName: "propose_patch", toolCallId: "call-1", state: "output-available", input: {}, output: { ok: true, proposal } }] } };
  const file = { path: "chapters/chapter-002.md", sha256: sha, version: 2, source: "author", protected: true, updatedAt: now, size: 31, content: "# 第二章\n主角转身离开。" };
  const job = { id: "job-1", novelId, goal: "write_chapters", scope: { fromChapter: 2, toChapter: 4 }, status: "awaiting_author", cursor: 2, baseStateHash: "b".repeat(64), createdAt: now, updatedAt: now };
  const snapshot = { novel: { schemaVersion: 2, novelId, title: "雾港来信", phase: "writing", currentVolume: 1, nextChapter: 2, activeJobId: job.id, approvalMode: "milestone", files: { [file.path]: file }, appliedProposalIds: [], updatedAt: now }, files: [file], activeJob: job, availability: { allowedOperations: [], blockers: [{ code: "ACTIVE_JOB", message: "当前作品已有生产任务。" }], activeJob: job } };
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
  await expect(page.getByRole("heading", { name: "收紧第二章转折" })).toBeVisible();
  await expect(page.locator(".line-diff .remove")).toContainText("主角转身离开。");
  await expect(page.locator(".line-diff .add").filter({ hasText: "主角决定留下。" })).toBeVisible();
  await expect(page.locator(".writing-main")).toHaveCSS("grid-template-columns", "390px");
});
