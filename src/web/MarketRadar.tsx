import { BookOpen, ExternalLink, LoaderCircle, Radar, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { persistMarketQuickStart, quickStartFromFeelCard, quickStartFromGenre, quickStartTitle, type MarketQuickStartSeed } from "./market-quick-start";

function platformLabel(platform: "fanqie" | "qidian" | "jinjiang") { return platform === "fanqie" ? "番茄小说" : platform === "jinjiang" ? "晋江文学城" : "起点中文网"; }
const capturedAtFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function MarketRadar() {
  const navigate = useNavigate();
  const [runId, setRunId] = useState<string>();
  const [runKind, setRunKind] = useState<"refresh" | "summary">();
  const [summaryScope, setSummaryScope] = useState("all");
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [selectedCapturedAt, setSelectedCapturedAt] = useState("");
  const snapshot = useQuery({ queryKey: ["market-radar", selectedCapturedAt], queryFn: () => api.marketRadar(selectedCapturedAt || undefined), placeholderData: (previous) => previous });
  const run = useQuery({ queryKey: ["market-radar-run", runId], queryFn: () => api.marketRadarRun(runId!), enabled: Boolean(runId), refetchInterval: (query) => query.state.data?.status === "running" ? 1_500 : false });
  const refresh = useMutation({ mutationFn: api.refreshMarketRadar, onSuccess: (next) => { setRunKind("refresh"); setRunId(next.id); } });
  const summarize = useMutation({ mutationFn: (sourceIds: string[]) => api.summarizeMarketRadar(sourceIds, snapshot.data?.snapshot?.capturedAt), onSuccess: (next) => { setRunKind("summary"); setRunId(next.id); } });
  const quickStart = useMutation({
    mutationFn: async (seed: MarketQuickStartSeed) => {
      const created = await api.createNovel(quickStartTitle(seed), seed.mode === "autonomous_opening" ? "autonomous_opening" : "milestone");
      persistMarketQuickStart(created.novelId, seed);
      await api.recordPreference(created.novelId, { kind: "choice", value: seed.label, scope: "novel", messageId: `market-${seed.mode}:${seed.id}` }).catch(() => undefined);
      return { novelId: created.novelId, seed };
    },
    onSuccess: ({ novelId, seed }) => navigate(`/novels/${novelId}`, { state: { marketQuickStart: seed } }),
  });
  useEffect(() => { if (run.data?.status === "completed") { if (runKind === "refresh") setSelectedCapturedAt(""); void snapshot.refetch(); setRunId(undefined); setRunKind(undefined); } }, [run.data?.status, runKind, snapshot]);
  const data = snapshot.data?.snapshot;
  const summary = snapshot.data?.summary;
  const rankingGroups = data?.sources.filter((source) => source.status === "succeeded").map((source) => ({ source, items: data.items.filter((item) => item.sourceId === source.id) })) ?? [];
  const selectedGroup = rankingGroups.find(({ source }) => source.id === selectedSourceId) ?? rankingGroups[0];
  const refreshing = refresh.isPending || (runKind === "refresh" && run.data?.status === "running");
  const runningSummary = summarize.isPending || (runKind === "summary" && run.data?.status === "running");
  const busy = refreshing || runningSummary || quickStart.isPending || snapshot.isFetching;

  return <main className="market-radar-page">
    <header className="market-radar-head"><Link to="/projects">← 作品</Link><div><small>MARKET RADAR</small><h1>市场趋势</h1><p>每次获取的公开榜单都会按时间保存，可随时查看并复用开书方向。</p></div><button disabled={busy} onClick={() => refresh.mutate()}>{refreshing ? <LoaderCircle className="spin" /> : <RefreshCw />}{refreshing ? "正在更新" : "更新公开榜单"}</button></header>
    <div className="market-ai-actions"><label><span>采集历史</span><select aria-label="选择市场趋势采集时间" disabled={busy} value={selectedCapturedAt} onChange={(event) => { setSelectedCapturedAt(event.target.value); setSelectedSourceId(undefined); setSummaryScope("all"); }}><option value="">最新快照</option>{snapshot.data?.history?.map((entry) => <option key={entry.capturedAt} value={entry.capturedAt}>{capturedAtFormatter.format(new Date(entry.capturedAt))} · {entry.itemCount} 条</option>)}</select></label></div>
    {snapshot.error ? <p className="market-radar-error">{snapshot.error.message}</p> : null}
    {refresh.error || summarize.error || quickStart.error || run.data?.status === "failed" ? <p className="market-radar-error">{refresh.error instanceof Error ? refresh.error.message : summarize.error instanceof Error ? summarize.error.message : quickStart.error instanceof Error ? quickStart.error.message : run.data?.error ?? "市场趋势处理失败。"}</p> : null}
    {snapshot.isLoading ? <div className="market-radar-empty"><LoaderCircle className="spin" />正在读取市场快照…</div> : !data ? <div className="market-radar-empty"><Radar /><h2>还没有市场数据</h2><p>点击“更新公开榜单”后，每次获取都会保留为可查看和复用的历史快照。</p></div> : <>
      <section className="market-radar-summary"><div><small>采集时间</small><strong>{capturedAtFormatter.format(new Date(data.capturedAt))}</strong></div><div><small>可用榜单</small><strong>{rankingGroups.length} / {data.sources.length} 个</strong></div><div><small>公开记录</small><strong>{data.items.length} 条</strong></div><div><small>数据边界</small><strong>仅书名、作者、分类与排名</strong></div></section>
      <section className="market-ai-summary">
        <header><div><small>AI DIRECTION</small><h2>题材观察与开书方向</h2><p>从公开榜单提炼题材信号和阅读感觉；结论只作灵感参考，不会自动修改作品。</p></div><div className="market-ai-actions"><label><span>分析范围</span><select disabled={busy} value={summaryScope} onChange={(event) => setSummaryScope(event.target.value)}><option value="all">全部榜单（每榜 Top 10）</option>{data.sources.filter((source) => source.status === "succeeded").map((source) => <option value={source.id} key={source.id}>{source.label}（Top 30）</option>)}</select></label><button disabled={busy} onClick={() => summarize.mutate([summaryScope])}>{runningSummary ? <LoaderCircle className="spin" /> : <Sparkles />}{runningSummary ? "正在生成方向" : "生成开书方向"}</button></div></header>
        {runningSummary ? <div className="market-ai-state" aria-live="polite"><LoaderCircle className="spin" /><div><strong>正在分析公开榜单</strong><span>完成后会在这里展示题材信号、阅读感觉和快速开书入口。</span></div></div> : null}
        {summary && snapshot.data?.summaryCurrent ? <><div className="market-ai-overview"><small>本次观察</small><p>{summary.overview}</p><span>分析范围：{summary.sourceIds.length > 1 ? "全部榜单（每榜 Top 10）" : data.sources.find((source) => source.id === summary.sourceIds[0])?.label}</span></div><section className="market-insight-section"><header><div><small>GENRE SIGNALS</small><h3>题材信号</h3></div><span>{summary.genres.length} 个方向</span></header><div className="market-genre-grid">{summary.genres.map((genre) => { const guided = quickStartFromGenre(genre); const automatic = quickStartFromGenre(genre, "autonomous_opening"); const pendingMode = quickStart.isPending && quickStart.variables?.id === guided.id ? quickStart.variables.mode : undefined; return <article key={genre.name}><strong>{genre.name}</strong><p>{genre.observation}</p><small>{genre.evidence.join(" · ")}</small><div className="market-open-actions"><button className="market-quick-start" disabled={quickStart.isPending} aria-label={`快速开书：${genre.name}`} onClick={() => quickStart.mutate(guided)}>{pendingMode === "guided" ? <LoaderCircle className="spin" /> : <BookOpen />}快速开书</button><button className="market-quick-start autonomous" disabled={quickStart.isPending} aria-label={`全自动开书：${genre.name}`} title="自动生成完整开书资产与前三章" onClick={() => quickStart.mutate(automatic)}>{pendingMode === "autonomous_opening" ? <LoaderCircle className="spin" /> : <Sparkles />}全自动开书</button></div></article>; })}</div></section><section className="market-insight-section"><header><div><small>READER FEEL</small><h3>阅读感觉</h3></div><span>{summary.feelCards.length} 个方向</span></header><div className="market-feel-grid">{summary.feelCards.map((card) => { const guided = quickStartFromFeelCard(card); const automatic = quickStartFromFeelCard(card, "autonomous_opening"); const pendingMode = quickStart.isPending && quickStart.variables?.id === guided.id ? quickStart.variables.mode : undefined; return <article key={card.id}><strong>{card.label}</strong><p>{card.reason}</p><small>会带入新作品的开书探索</small><div className="market-open-actions"><button className="market-quick-start" disabled={quickStart.isPending} aria-label={`快速开书：${card.label}`} onClick={() => quickStart.mutate(guided)}>{pendingMode === "guided" ? <LoaderCircle className="spin" /> : <BookOpen />}快速开书</button><button className="market-quick-start autonomous" disabled={quickStart.isPending} aria-label={`全自动开书：${card.label}`} title="自动生成完整开书资产与前三章" onClick={() => quickStart.mutate(automatic)}>{pendingMode === "autonomous_opening" ? <LoaderCircle className="spin" /> : <Sparkles />}全自动开书</button></div></article>; })}</div></section></> : !runningSummary ? <div className="market-ai-state idle"><Sparkles /><div><strong>{summary ? "榜单已经更新，需要重新生成方向" : "还没有生成开书方向"}</strong><span>选择全部榜单看整体趋势，或选择单榜观察具体频道。</span></div></div> : null}
      </section>
      <section className="market-ranking"><header><div><small>RAW EVIDENCE</small><h2>原始榜单证据</h2></div><span>选择一张榜单查看，排名只在对应榜单内有效。</span></header><nav className="market-source-tabs" aria-label="选择榜单">{rankingGroups.map(({ source, items }) => <button type="button" key={source.id} aria-pressed={selectedGroup?.source.id === source.id} onClick={() => setSelectedSourceId(source.id)}><span>{platformLabel(source.platform)}</span><strong>{source.label}</strong><em>{items.length} 条</em></button>)}</nav>{selectedGroup ? <section className="market-ranking-group"><header><div><small>{platformLabel(selectedGroup.source.platform)} · {selectedGroup.items.length} 条公开记录</small><h3>{selectedGroup.source.label}</h3></div><a href={selectedGroup.source.sourceUrl} target="_blank" rel="noreferrer">查看公开榜单 <ExternalLink /></a></header><div className="market-ranking-table"><div className="market-ranking-row heading"><span>本榜排名</span><span>作品</span><span>作者 / 分类</span><span>来源</span></div>{selectedGroup.items.map((item) => <div className="market-ranking-row" key={item.id}><span>#{item.rank}</span><strong>{item.title}</strong><span>{[item.author, item.category, item.heatLabel].filter(Boolean).join(" · ") || "公开页未标注"}</span><a href={item.sourceUrl} target="_blank" rel="noreferrer" aria-label={`查看${item.title}公开来源`}><ExternalLink /></a></div>)}</div></section> : null}</section>
    </>}
  </main>;
}
