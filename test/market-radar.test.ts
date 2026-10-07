import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hasPrivateUseCharacters, MarketRadarRepository, parseFanqieDetail, parseFanqieRanking, parseJinjiangRanking, parseQidianRanking } from "../src/infrastructure/market-radar-repository";
import { marketRadarSummaryContext, marketRadarSummaryFromModel } from "../src/mastra/workflows/market-radar-summary-workflow";
import { clearMarketQuickStart, markMarketQuickStartAttempted, persistMarketQuickStart, quickStartFromFeelCard, quickStartFromGenre, quickStartTitle, readMarketQuickStart, wasMarketQuickStartAttempted } from "../src/web/market-quick-start";

const source = { id: "qidian-new", platform: "qidian" as const, label: "起点 · 新书榜", sourceUrl: "https://m.qidian.com/rank/" };
const page = '<a href="/book/123"><h2 title="新书榜第1位">雾港来信</h2><p class="subTitle">南舟 · 都市异能 · 连载</p></a>';
const jinjiangPage = '<li><a href="/book2/456">春山有信</a></li>';
const fanqiePage = '<main><div class="rank-book-item"><div class="book-item-index"><h1>01</h1></div><div class="title"><a href="/page/789">废城经营手册</a></div><div class="author"><a><span>南风</span></a></div><div class="book-item-footer">连载中 在读：12万</div></div></main>';

test("public ranking parser keeps only bounded metadata", () => {
  const items = parseQidianRanking(`${page}<a href="/book/999"><h2 title="畅销榜第1位">不应混入</h2><p class="subTitle">某人 · 玄幻 · 连载</p></a>`, source);
  const [item] = items;
  assert.equal(items.length, 1);
  assert.deepEqual({ rank: item?.rank, title: item?.title, author: item?.author, category: item?.category, heatLabel: item?.heatLabel }, { rank: 1, title: "雾港来信", author: "南舟", category: "都市异能", heatLabel: "连载" });
  assert.match(item?.sourceUrl ?? "", /\/book\/123/);
});

test("Jinjiang parser keeps rank, title, and source URL only", () => {
  const [item] = parseJinjiangRanking(jinjiangPage, { id: "jinjiang-monthly", platform: "jinjiang", label: "晋江 · 月度榜", sourceUrl: "https://m.jjwxc.net/rank/naturalmore/5" });
  assert.deepEqual({ rank: item?.rank, title: item?.title }, { rank: 1, title: "春山有信" });
  assert.match(item?.sourceUrl ?? "", /\/book2\/456/);
});

test("Fanqie parser keeps public ranking metadata and detail pages repair private-use text", () => {
  const fanqieSource = { id: "fanqie-new", platform: "fanqie" as const, label: "番茄 · 新书榜", sourceUrl: "https://fanqienovel.com/rank/1_1" };
  const [item] = parseFanqieRanking(fanqiePage, fanqieSource);
  assert.deepEqual({ rank: item?.rank, title: item?.title, author: item?.author }, { rank: 1, title: "废城经营手册", author: "南风" });
  const repaired = parseFanqieDetail('<h1>退休勇者买下魔王</h1><a class="author-name-text">晴空飞鸟</a>', { ...item!, title: "退休勇买魔王" });
  assert.equal(hasPrivateUseCharacters("退休勇买魔王"), true);
  assert.equal(repaired.title, "退休勇者买下魔王");
});

test("market radar writes successful sources while preserving failed-source evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-market-radar-"));
  try {
    const repository = new MarketRadarRepository(root, async (input) => {
      const url = String(input);
      const failed = url.includes("qidian.com/rank/hotsales");
      return new Response(url.includes("fanqienovel.com") ? fanqiePage : url.includes("jjwxc.net") ? jinjiangPage : page, { status: failed ? 503 : 200 });
    });
    const snapshot = await repository.refresh();
    assert.equal(snapshot.items.length, 5);
    assert.equal(snapshot.sources.filter((item) => item.status === "failed").length, 1);
    assert.equal(snapshot.sources.filter((item) => item.platform === "fanqie" && item.status === "succeeded").length, 2);
    assert.equal(snapshot.sources.filter((item) => item.platform === "jinjiang" && item.status === "succeeded").length, 2);
    assert.equal((await repository.get())?.items.find((item) => item.sourceId === "qidian-new")?.title, "雾港来信");
    assert.match(await readFile(path.join(root, "latest.yaml"), "utf8"), /schemaVersion: 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("market genre summary is persisted separately from raw ranking evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-market-summary-"));
  try {
    const repository = new MarketRadarRepository(root);
    await repository.saveSummary({ schemaVersion: 1, snapshotCapturedAt: "2026-08-26T00:00:00.000Z", sourceIds: ["qidian-new"], generatedAt: "2026-08-26T00:01:00.000Z", overview: "公开快照显示多种题材并行出现，这只是可观察到的偏好信号，不是成功保证。", genres: [{ name: "都市异能", observation: "分类标签中多次出现都市异能。", evidence: ["都市异能"] }, { name: "经营成长", observation: "榜单标题可见经营与成长线索。", evidence: ["经营"] }], feelCards: [{ id: "growth", label: "成长破局", prompt: "我想写主角依靠专业能力持续成长并解决更大难题的长篇故事。", reason: "来自公开快照中可见的成长与破局信号。" }, { id: "business", label: "经营积累", prompt: "我想写从小资源起步、通过经营逐步积累成果的长篇故事。", reason: "来自公开快照中可见的经营信号。" }, { id: "mystery", label: "谜团推进", prompt: "我想写谜团层层揭开并持续推进主线目标的长篇故事。", reason: "来自公开快照中可见的悬念信号。" }, { id: "relationship", label: "关系博弈", prompt: "我想写强关系互动与目标冲突交织推进的长篇故事。", reason: "来自公开快照中可见的关系信号。" }] });
    assert.equal((await repository.getSummary())?.feelCards.length, 4);
    assert.match(await readFile(path.join(root, "genre-summary.yaml"), "utf8"), /snapshotCapturedAt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("market history preserves legacy snapshots and summaries for reuse after refresh", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-market-history-"));
  try {
    let title = "雾港来信";
    const repository = new MarketRadarRepository(root, async () => new Response(page.replace("雾港来信", title)));
    assert.deepEqual(await repository.history(), []);
    const legacy = { schemaVersion: 1, capturedAt: "2026-08-26T00:00:00.000Z", sources: [{ ...source, status: "succeeded", itemCount: 1 }], items: parseQidianRanking(page, source) };
    await writeFile(path.join(root, "latest.yaml"), JSON.stringify(legacy), "utf8");
    assert.deepEqual(await repository.get(legacy.capturedAt), legacy);
    assert.equal((await repository.history()).length, 1);
    const model = { overview: "公开快照显示都市异能和经营成长信号，只作为原创开书灵感。", genres: [{ name: "都市异能", observation: "榜单出现都市异能。", evidence: ["都市异能"] }, { name: "经营成长", observation: "榜单出现经营成长。", evidence: ["经营成长"] }], feelCards: ["growth", "business", "mystery", "relationship"].map((id) => ({ id, label: "成长破局", prompt: "我想写主角通过专业能力持续成长并解决更大难题的原创长篇小说。", reason: "来自公开快照中可见的成长信号。" })) };
    const summary = marketRadarSummaryFromModel(model, undefined, legacy.capturedAt, [source.id]);
    await writeFile(path.join(root, "genre-summary.yaml"), JSON.stringify(summary), "utf8");
    const first = await repository.refresh();
    title = "新榜单作品";
    const second = await repository.refresh();
    const reopened = new MarketRadarRepository(root, async () => { throw new Error("历史读取不应联网"); });
    assert.deepEqual((await reopened.history()).map((entry) => entry.capturedAt), [second.capturedAt, first.capturedAt, legacy.capturedAt]);
    assert.deepEqual(await reopened.get(legacy.capturedAt), legacy);
    assert.equal((await reopened.get(first.capturedAt))?.items[0]?.title, "雾港来信");
    assert.equal((await reopened.get())?.items[0]?.title, "新榜单作品");
    assert.deepEqual(await reopened.getSummary(legacy.capturedAt), summary);
    assert.equal(await reopened.getSummary(second.capturedAt), undefined);
    const currentSummary = { ...summary, snapshotCapturedAt: second.capturedAt };
    await reopened.saveSummary(currentSummary);
    await reopened.saveSummary({ ...summary, overview: "历史榜单重新生成的观察结果，保留旧的采集时间并用于原创开书。" });
    assert.deepEqual(await reopened.getSummary(), currentSummary);
    assert.equal((await reopened.getSummary(legacy.capturedAt))?.overview, "历史榜单重新生成的观察结果，保留旧的采集时间并用于原创开书。");
    assert.equal(await reopened.get("2020-01-01T00:00:00.000Z"), undefined);
    await assert.rejects(() => reopened.get("../../latest"), RangeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("market summary accepts a valid JSON-text response when a provider omits result.object", () => {
  const value = { overview: "公开快照呈现多个题材信号，但不能把它视为成功保证。", genres: [{ name: "都市异能", observation: "公开分类多次出现都市异能。", evidence: ["都市异能"] }, { name: "经营成长", observation: "公开标题呈现经营成长线索。", evidence: ["经营"] }], feelCards: [{ id: "growth", label: "成长破局", prompt: "我想写主角依靠专业能力持续成长并解决更大难题的长篇故事。", reason: "来自公开快照中的成长信号。" }, { id: "business", label: "经营积累", prompt: "我想写从小资源起步、通过经营逐步积累成果的长篇故事。", reason: "来自公开快照中的经营信号。" }, { id: "mystery", label: "谜团推进", prompt: "我想写谜团层层揭开并持续推进主线目标的长篇故事。", reason: "来自公开快照中的悬念信号。" }, { id: "relation", label: "关系博弈", prompt: "我想写强关系互动与目标冲突交织推进的长篇故事。", reason: "来自公开快照中的关系信号。" }] };
  const summary = marketRadarSummaryFromModel(undefined, JSON.stringify(value), "2026-08-26T00:00:00.000Z", ["qidian-new"]);
  assert.equal(summary.feelCards.length, 4);
  assert.equal(summary.genres[0]?.name, "都市异能");
});

test("market summary accepts JSON wrapped in explanatory text", () => {
  const value = { overview: "公开快照呈现多个题材信号，但不能把它视为成功保证。", genres: [{ name: "都市异能", observation: "公开分类多次出现都市异能。", evidence: ["都市异能"] }, { name: "经营成长", observation: "公开标题呈现经营成长线索。", evidence: ["经营"] }], feelCards: [{ id: "growth", label: "成长破局", prompt: "我想写主角依靠专业能力持续成长并解决更大难题的长篇故事。", reason: "来自公开快照中的成长信号。" }, { id: "business", label: "经营积累", prompt: "我想写从小资源起步、通过经营逐步积累成果的长篇故事。", reason: "来自公开快照中的经营信号。" }, { id: "mystery", label: "谜团推进", prompt: "我想写谜团层层揭开并持续推进主线目标的长篇故事。", reason: "来自公开快照中的悬念信号。" }, { id: "relation", label: "关系博弈", prompt: "我想写强关系互动与目标冲突交织推进的长篇故事。", reason: "来自公开快照中的关系信号。" }] };
  const summary = marketRadarSummaryFromModel(undefined, `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, "2026-08-26T00:00:00.000Z", ["qidian-new"]);
  assert.equal(summary.sourceIds[0], "qidian-new");
});

test("market summary context caps each source and removes repeated books", () => {
  const items = Array.from({ length: 35 }, (_, index) => ({ id: `item-${index}`, sourceId: "qidian-new", rank: index + 1, title: `作品${index}`, sourceUrl: `https://example.com/${index}` }));
  items.splice(1, 0, { ...items[0]!, id: "duplicate", rank: 2 });
  const snapshot = { schemaVersion: 1 as const, capturedAt: "2026-08-26T00:00:00.000Z", sources: [{ ...source, status: "succeeded" as const, itemCount: items.length }], items };
  assert.equal(marketRadarSummaryContext(snapshot, ["qidian-new"]).length, 30);
  assert.equal(marketRadarSummaryContext({ ...snapshot, sources: [...snapshot.sources, { ...source, id: "qidian-hot", status: "succeeded" as const, itemCount: 35 }], items: [...items, ...items.map((item) => ({ ...item, id: `hot-${item.id}`, sourceId: "qidian-hot" }))] }, ["qidian-new", "qidian-hot"]).length, 20);
});

test("market cards create bounded original quick-start prompts", () => {
  const genre = quickStartFromGenre({ name: "都市异能", observation: "公开分类多次出现都市异能与悬疑信号。", evidence: ["都市异能", "悬疑"] });
  assert.equal(quickStartTitle(genre), "未命名 · 都市异能");
  assert.match(genre.prompt, /都市异能/);
  assert.match(genre.prompt, /公开榜单信号：都市异能、悬疑/);
  assert.match(genre.prompt, /三个差异明显的原创故事种子/);
  assert.match(genre.prompt, /不要模仿或复制/);

  const feeling = quickStartFromFeelCard({ id: "growth", label: "成长破局", prompt: "我想写主角持续成长并解决更大难题的长篇故事。", reason: "来自公开快照的成长信号。" });
  assert.match(feeling.prompt, /主角持续成长/);
  assert.match(feeling.prompt, /来自公开快照的成长信号/);
  assert.equal(feeling.id, "feel:growth");
});

test("market quick-start intent is persisted per novel until explicitly cleared", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const seed = quickStartFromGenre({ name: "都市异能", observation: "观察", evidence: ["都市异能"] }, "autonomous_opening");
  persistMarketQuickStart("novel-a", seed, storage);
  assert.deepEqual(readMarketQuickStart("novel-a", storage), seed);
  assert.equal(wasMarketQuickStartAttempted("novel-a", storage), false);
  markMarketQuickStartAttempted("novel-a", storage);
  assert.equal(wasMarketQuickStartAttempted("novel-a", storage), true);
  assert.equal(readMarketQuickStart("novel-b", storage), undefined);
  clearMarketQuickStart("novel-a", storage);
  assert.equal(readMarketQuickStart("novel-a", storage), undefined);
  assert.equal(wasMarketQuickStartAttempted("novel-a", storage), false);
});
