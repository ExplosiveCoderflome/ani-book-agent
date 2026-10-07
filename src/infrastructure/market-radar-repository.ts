import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { marketRadarSnapshotSchema, marketRadarSummarySchema, type MarketRadarSnapshot, type MarketRadarSummary, type MarketPlatform } from "../domain";

type Source = { id: string; platform: MarketPlatform; label: string; sourceUrl: string };
type Fetcher = typeof fetch;
type RankingItem = MarketRadarSnapshot["items"][number];
const sources: Source[] = [
  { id: "fanqie-reading", platform: "fanqie", label: "番茄 · 阅读榜", sourceUrl: "https://fanqienovel.com/rank" },
  { id: "fanqie-new", platform: "fanqie", label: "番茄 · 新书榜", sourceUrl: "https://fanqienovel.com/rank/1_1" },
  { id: "qidian-new", platform: "qidian", label: "起点 · 新书榜", sourceUrl: "https://m.qidian.com/rank/" },
  { id: "qidian-hot", platform: "qidian", label: "起点 · 畅销榜", sourceUrl: "https://m.qidian.com/rank/hotsales/" },
  { id: "jinjiang-monthly", platform: "jinjiang", label: "晋江 · 月度榜", sourceUrl: "https://m.jjwxc.net/rank/naturalmore/5" },
  { id: "jinjiang-new-author", platform: "jinjiang", label: "晋江 · 新晋作者榜", sourceUrl: "https://m.jjwxc.net/rank/naturalmore/29" },
];

function plainText(value: string) { return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim(); }
function absoluteUrl(base: string, value: string) { return new URL(value, base).toString(); }
export function parseQidianRanking(html: string, source: Source) {
  const rankLabel = source.label.split("·").at(-1)?.trim() ?? source.label;
  const escapedLabel = rankLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = [...html.matchAll(new RegExp(`<a[^>]+href="([^"]*\\/book\\/[^"?]+)[^"]*"[^>]*>[\\s\\S]*?<h2[^>]+title="${escapedLabel}第(\\d+)位"[^>]*>([\\s\\S]*?)<\\/h2>[\\s\\S]*?<p[^>]*class="[^"]*subTitle[^"]*"[^>]*>([\\s\\S]*?)<\\/p>[\\s\\S]*?<\\/a>`, "g"))].slice(0, 30);
  return rows.map((match) => {
    const parts = plainText(match[4] ?? "").split("·").map((part) => part.trim()).filter(Boolean);
    const title = plainText(match[3] ?? "");
    return { id: createHash("sha256").update(`${source.id}:${match[2]}:${title}`, "utf8").digest("hex").slice(0, 24), sourceId: source.id, rank: Number(match[2]), title, author: parts[0], category: parts[1], heatLabel: parts[2], sourceUrl: absoluteUrl(source.sourceUrl, match[1] ?? "") };
  }).filter((item) => item.title && Number.isInteger(item.rank) && item.rank > 0);
}

export function parseJinjiangRanking(html: string, source: Source) {
  const rows = [...html.matchAll(/<li[^>]*>\s*<a[^>]+href="((?:https?:)?\/\/[^\"]*\/book2\/\d+|\/book2\/\d+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/g)].slice(0, 30);
  return rows.map((match, index) => {
    const title = plainText(match[2] ?? "");
    return { id: createHash("sha256").update(`${source.id}:${index + 1}:${title}`, "utf8").digest("hex").slice(0, 24), sourceId: source.id, rank: index + 1, title, sourceUrl: absoluteUrl(source.sourceUrl, match[1] ?? "") };
  }).filter((item) => item.title);
}

export function hasPrivateUseCharacters(value: string | undefined) { return /[\uE000-\uF8FF]/u.test(value ?? ""); }

export function parseFanqieRanking(html: string, source: Source) {
  const blocks = html.match(/<div class="rank-book-item">[\s\S]*?(?=<div class="rank-book-item">|<\/main>|<footer|<\/body>)/g) ?? [];
  return blocks.slice(0, 30).flatMap((block, index) => {
    const titleMatch = block.match(/<div class="title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) return [];
    const title = plainText(titleMatch[2] ?? "");
    const author = plainText(block.match(/<div class="author">[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
    const footer = plainText(block.match(/<div class="book-item-footer">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const rank = Number(block.match(/book-item-index"><h1>0?(\d+)<\/h1>/)?.[1] ?? index + 1);
    const sourceUrl = absoluteUrl(source.sourceUrl, titleMatch[1] ?? "");
    return [{ id: createHash("sha256").update(`${source.id}:${rank}:${sourceUrl}`, "utf8").digest("hex").slice(0, 24), sourceId: source.id, rank, title, author: author || undefined, heatLabel: footer.match(/在读[^，。]*/)?.[0], sourceUrl }];
  }).filter((item) => item.title && Number.isInteger(item.rank) && item.rank > 0);
}

export function parseFanqieDetail(html: string, item: RankingItem) {
  const title = plainText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const author = plainText(html.match(/author-name-text[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
  if (!title || hasPrivateUseCharacters(title)) throw new Error("作品详情页未提供可读书名");
  return { ...item, title, author: author && !hasPrivateUseCharacters(author) ? author : undefined };
}

function parseRanking(html: string, source: Source) {
  if (source.platform === "fanqie") return parseFanqieRanking(html, source);
  return source.platform === "jinjiang" ? parseJinjiangRanking(html, source) : parseQidianRanking(html, source);
}

async function readRankingPage(response: Response, source: Source) {
  if (source.platform !== "jinjiang") return response.text();
  return new TextDecoder("gb18030").decode(await response.arrayBuffer());
}

async function hydrateFanqieItems(items: RankingItem[], fetcher: Fetcher) {
  const hydrated: RankingItem[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    const batch = await Promise.all(items.slice(offset, offset + 4).map(async (item) => {
      if (![item.title, item.author].some(hasPrivateUseCharacters)) return item;
      try {
        const response = await fetcher(item.sourceUrl, { headers: { "user-agent": "ANI-Novel-Agent/1.0 public-ranking-metadata-only" }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return null;
        return parseFanqieDetail(await response.text(), item);
      } catch { return null; }
    }));
    hydrated.push(...batch.filter((item): item is NonNullable<typeof item> => item !== null));
  }
  return hydrated;
}

async function atomicWrite(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

export class MarketRadarRepository {
  private readonly filePath: string;
  private readonly summaryPath: string;
  private readonly historyPath: string;
  constructor(root = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), "market-radar"), private readonly fetcher: Fetcher = fetch) { this.filePath = path.join(root, "latest.yaml"); this.summaryPath = path.join(root, "genre-summary.yaml"); this.historyPath = path.join(root, "history"); }
  private snapshotPath(capturedAt: string) { return path.join(this.historyPath, new Date(capturedAt).toISOString().replaceAll(":", "-")); }
  async get(capturedAt?: string): Promise<MarketRadarSnapshot | undefined> {
    try { return marketRadarSnapshotSchema.parse(parse(await readFile(capturedAt ? path.join(this.snapshotPath(capturedAt), "snapshot.yaml") : this.filePath, "utf8"))); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") { const snapshot = capturedAt ? await this.get() : undefined; return snapshot?.capturedAt === capturedAt ? snapshot : undefined; } throw error; }
  }
  async history(): Promise<Array<{ capturedAt: string; itemCount: number }>> {
    let entries: string[];
    try { entries = await readdir(this.historyPath); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") entries = []; else throw error; }
    const records = await Promise.all(entries.map(async (entry) => {
      try { return marketRadarSnapshotSchema.parse(parse(await readFile(path.join(this.historyPath, entry, "snapshot.yaml"), "utf8"))); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    }));
    const snapshots = records.filter((snapshot): snapshot is MarketRadarSnapshot => Boolean(snapshot));
    const latest = await this.get();
    if (latest && !snapshots.some((snapshot) => snapshot.capturedAt === latest.capturedAt)) snapshots.push(latest);
    return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).map((snapshot) => ({ capturedAt: snapshot.capturedAt, itemCount: snapshot.items.length }));
  }
  async getSummary(capturedAt?: string): Promise<MarketRadarSummary | undefined> {
    try { return marketRadarSummarySchema.parse(parse(await readFile(capturedAt ? path.join(this.snapshotPath(capturedAt), "summary.yaml") : this.summaryPath, "utf8"))); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") { const summary = capturedAt ? await this.getSummary() : undefined; return summary?.snapshotCapturedAt === capturedAt ? summary : undefined; } throw error; }
  }
  private async archiveLatest() {
    const snapshot = await this.get();
    if (snapshot) await atomicWrite(path.join(this.snapshotPath(snapshot.capturedAt), "snapshot.yaml"), stringify(snapshot, { lineWidth: 0 }));
    const summary = await this.getSummary();
    if (summary) await atomicWrite(path.join(this.snapshotPath(summary.snapshotCapturedAt), "summary.yaml"), stringify(summary, { lineWidth: 0 }));
  }
  async saveSummary(summary: MarketRadarSummary) {
    const validated = marketRadarSummarySchema.parse(summary);
    await this.archiveLatest();
    await atomicWrite(path.join(this.snapshotPath(validated.snapshotCapturedAt), "summary.yaml"), stringify(validated, { lineWidth: 0 }));
    const latest = await this.get();
    if (!latest || latest.capturedAt === validated.snapshotCapturedAt) await atomicWrite(this.summaryPath, stringify(validated, { lineWidth: 0 }));
  }
  async refresh(): Promise<MarketRadarSnapshot> {
    const results = await Promise.all(sources.map(async (source) => {
      try {
        const response = await this.fetcher(source.sourceUrl, { headers: { "user-agent": "ANI-Novel-Agent/1.0 public-ranking-metadata-only" }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`榜单页面返回 HTTP ${response.status}`);
        const parsed = parseRanking(await readRankingPage(response, source), source);
        const items = source.platform === "fanqie" ? await hydrateFanqieItems(parsed, this.fetcher) : parsed;
        if (!items.length) throw new Error("页面结构变化，未识别到公开作品元数据");
        return { source: { ...source, status: "succeeded" as const, itemCount: items.length }, items };
      } catch (error) { return { source: { ...source, status: "failed" as const, itemCount: 0, error: error instanceof Error ? error.message : "榜单采集失败" }, items: [] }; }
    }));
    const previous = await this.get();
    const capturedAt = new Date(Math.max(Date.now(), previous ? Date.parse(previous.capturedAt) + 1 : 0)).toISOString();
    const snapshot = marketRadarSnapshotSchema.parse({ schemaVersion: 1, capturedAt, sources: results.map((result) => result.source), items: results.flatMap((result) => result.items) });
    await this.archiveLatest();
    await atomicWrite(path.join(this.snapshotPath(snapshot.capturedAt), "snapshot.yaml"), stringify(snapshot, { lineWidth: 0 }));
    await atomicWrite(this.filePath, stringify(snapshot, { lineWidth: 0 }));
    return snapshot;
  }
}
